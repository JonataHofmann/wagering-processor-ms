import {
  type SqsConfig,
  sqsConfigFromEnv,
} from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
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
  /** sends a message to the main queue, as a provider would */
  /** consumes (and deletes) whatever arrived in the events queue since the last call */
  drainEvents(): Promise<
    Array<{
      body: Record<string, any>;
      groupId?: string;
      deduplicationId?: string;
      eventType?: string;
    }>
  >;
  send(
    body: unknown,
    options: { groupId: string; deduplicationId?: string },
  ): Promise<void>;
  /** messages visible + in flight in the main queue */
  depth(): Promise<number>;
  /** reads (without deleting) whatever is in the DLQ */
  deadLetters(): Promise<
    Array<{ body: string; attributes: Record<string, MessageAttributeValue> }>
  >;
  drop(): Promise<void>;
}

/**
 * Creates a FIFO queue pair exclusive to the suite (main + DLQ with redrive),
 * on the LocalStack/MiniStack configured in .env. Nothing is shared with the development environment.
 */
export async function createTestQueues(
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const base = sqsConfigFromEnv();
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const mainName = `wt-${suffix}.fifo`;
  const eventsName = `wt-events-${suffix}.fifo`;
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
  const events = await client.send(
    new CreateQueueCommand({
      QueueName: eventsName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const config: SqsConfig = {
    ...base,
    queues: {
      wagerTransactions: mainName,
      wagerTransactionsDlq: dlqName,
      walletEvents: eventsName,
    },
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
          VisibilityTimeout: 0, // just peeking: messages stay available
          MessageAttributeNames: ['All'],
        }),
      );
      return (Messages ?? []).map((m) => ({
        body: m.Body ?? '',
        attributes: m.MessageAttributes ?? {},
      }));
    },
    async drainEvents() {
      const received: Array<{
        body: Record<string, any>;
        groupId?: string;
        deduplicationId?: string;
        eventType?: string;
      }> = [];
      for (;;) {
        const { Messages } = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: events.QueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
        );
        if (!Messages || Messages.length === 0) return received;
        for (const m of Messages) {
          received.push({
            body: JSON.parse(m.Body ?? '{}'),
            groupId: m.Attributes?.MessageGroupId,
            deduplicationId: m.Attributes?.MessageDeduplicationId,
            eventType: m.MessageAttributes?.eventType?.StringValue,
          });
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: events.QueueUrl,
              ReceiptHandle: m.ReceiptHandle,
            }),
          );
        }
      }
    },
    async drop() {
      await client
        .send(new DeleteQueueCommand({ QueueUrl: main.QueueUrl }))
        .catch(() => undefined);
      await client
        .send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }))
        .catch(() => undefined);
      await client
        .send(new DeleteQueueCommand({ QueueUrl: events.QueueUrl }))
        .catch(() => undefined);
      client.destroy();
    },
  };
}

/** Waits for a condition to become true (polling), or fails with the given message. */
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
    SQS_WAGER_QUEUE: queues.config.queues.wagerTransactions,
    SQS_WAGER_DLQ: queues.config.queues.wagerTransactionsDlq,
    SQS_WAIT_TIME_SECONDS: String(queues.config.consumer.waitTimeSeconds),
    SQS_MAX_RECEIVE_COUNT: String(queues.config.consumer.maxReceiveCount),
    SQS_SHUTDOWN_TIMEOUT_MS: String(queues.config.consumer.shutdownTimeoutMs),
    SQS_EVENTS_QUEUE: queues.config.queues.walletEvents,
    ...extra,
  };
}

export function relayEnv(
  queues: TestQueues,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    SQS_EVENTS_QUEUE: queues.config.queues.walletEvents,
    OUTBOX_LEASE_MS: '2000', // short lease: the test shouldn't have to wait 30s
    OUTBOX_IDLE_INTERVAL_MS: '100',
    ...extra,
  };
}

export function schedulerEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    SCHEDULER_LEASE_MS: '2000',
    SCHEDULER_IDLE_INTERVAL_MS: '100',
    PENDING_REFERENCE_BACKOFF_BASE_MS: '200',
    PENDING_REFERENCE_BACKOFF_MAX_MS: '800',
    ...extra,
  };
}
