import {
  type SqsConfig,
  sqsConfigFromEnv,
} from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface TestQueues {
  config: SqsConfig;
  client: SQSClient;
  /** envia uma mensagem para a fila principal, como um provedor faria */
  send(
    body: unknown,
    options: { groupId: string; deduplicationId?: string },
  ): Promise<void>;
  /** mensagens visíveis + em processamento na fila principal */
  depth(): Promise<number>;
  /** lê (sem apagar) o que estiver na DLQ */
  deadLetters(): Promise<
    Array<{ body: string; attributes: Record<string, MessageAttributeValue> }>
  >;
  drop(): Promise<void>;
}

/**
 * Cria um par de filas FIFO exclusivo da suíte (principal + DLQ com redrive),
 * no LocalStack/MiniStack configurado no .env. Nada é compartilhado com o ambiente de desenvolvimento.
 */
export async function createTestQueues(
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const base = sqsConfigFromEnv();
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const mainName = `wt-${suffix}.fifo`;
  const dlqName = `wt-dlq-${suffix}.fifo`;
  const maxReceiveCount = options.maxReceiveCount ?? 3;

  const client = new SQSClient({
    region: base.region,
    endpoint: base.endpoint,
    credentials: base.credentials,
  });

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const dlqArn = (
    await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    )
  ).Attributes!.QueueArn!;

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: mainName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 10),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );

  const config: SqsConfig = {
    ...base,
    queues: { wagerTransactions: mainName, wagerTransactionsDlq: dlqName },
    consumer: { waitTimeSeconds: 1, maxReceiveCount, shutdownTimeoutMs: 5_000 },
  };

  return {
    config,
    client,
    async send(body, { groupId, deduplicationId }) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: main.QueueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: deduplicationId ?? crypto.randomUUID(),
        }),
      );
    },
    async depth() {
      const { Attributes } = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: main.QueueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        }),
      );
      return (
        Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    },
    async deadLetters() {
      const { Messages } = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlq.QueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0, // só olha: continuam disponíveis
          MessageAttributeNames: ['All'],
        }),
      );
      return (Messages ?? []).map((m) => ({
        body: m.Body ?? '',
        attributes: m.MessageAttributes ?? {},
      }));
    },
    async drop() {
      await client
        .send(new DeleteQueueCommand({ QueueUrl: main.QueueUrl }))
        .catch(() => undefined);
      await client
        .send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }))
        .catch(() => undefined);
      client.destroy();
    },
  };
}

/** Espera uma condição ficar verdadeira (polling), ou falha com a mensagem informada. */
export async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for: ${description}`,
  );
}
export function consumerEnv(
  queues: TestQueues,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    APP_ROLES: 'api,consumer',
    SQS_WAGER_QUEUE: queues.config.queues.wagerTransactions,
    SQS_WAGER_DLQ: queues.config.queues.wagerTransactionsDlq,
    SQS_WAIT_TIME_SECONDS: String(queues.config.consumer.waitTimeSeconds),
    SQS_MAX_RECEIVE_COUNT: String(queues.config.consumer.maxReceiveCount),
    SQS_SHUTDOWN_TIMEOUT_MS: String(queues.config.consumer.shutdownTimeoutMs),
    ...extra,
  };
}
