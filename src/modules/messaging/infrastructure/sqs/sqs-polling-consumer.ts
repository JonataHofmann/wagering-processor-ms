import { runWithLogContext } from '@/src/platform/observability/log-context';
import type { Metrics } from '@/src/platform/observability/metrics';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type {
  MessageDisposition,
  MessageHandlerFn,
} from './message-disposition';

export interface SqsPollingConsumerOptions {
  /** nome para logs */
  name: string;
  queueName: string;
  deadLetterQueueName: string;
  waitTimeSeconds: number;
  /** na tentativa número maxReceiveCount, um retry vira DLQ explícita (com o motivo) */
  maxReceiveCount: number;
  shutdownTimeoutMs: number;
  /** atraso antes de a mensagem voltar a ficar visível, por número de recebimentos */
  retryBackoff?: ExponentialBackoff;
  handle: MessageHandlerFn;
  metrics?: Metrics;
}

const MAX_BATCH_SIZE = 10;
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200; // limite do SQS: 12 h
const MAX_DLQ_DETAIL_LENGTH = 1_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Long polling de uma fila SQS, executando a decisão do handler:
 * - ack só depois que o handler terminou (o commit já aconteceu dentro dele);
 * - mensagens do mesmo MessageGroupId em sequência, grupos diferentes em paralelo;
 * - retry com backoff via ChangeMessageVisibility; DLQ explícita com o motivo;
 * - stop(): para de receber, termina o que está em andamento e devolve o resto.
 */
export class SqsPollingConsumer {
  private readonly logger: Logger;
  private readonly retryBackoff: ExponentialBackoff;
  private readonly pollErrorBackoff = new ExponentialBackoff({
    baseMs: 500,
    maxMs: 30_000,
  });
  private queueUrl = '';
  private deadLetterQueueUrl = '';
  private stopping = false;
  private loop: Promise<void> | undefined;
  private receiveAbort: AbortController | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsPollingConsumerOptions,
  ) {
    this.logger = new Logger(`SqsConsumer:${options.name}`);
    this.retryBackoff =
      options.retryBackoff ??
      new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 });
  }

  async start(): Promise<void> {
    this.queueUrl = await this.resolveQueueUrl(this.options.queueName);
    this.deadLetterQueueUrl = await this.resolveQueueUrl(
      this.options.deadLetterQueueName,
    );
    this.stopping = false;
    this.loop = this.run();
    this.logger.log(`consuming ${this.options.queueName}`);
  }

  /** Para de receber, termina as mensagens em andamento (até shutdownTimeoutMs) e devolve as não iniciadas. */
  async stop(): Promise<void> {
    if (this.loop === undefined) return;
    this.stopping = true;
    this.receiveAbort?.abort();
    const finished = await Promise.race([
      this.loop.then(() => true),
      sleep(this.options.shutdownTimeoutMs).then(() => false),
    ]);
    if (!finished)
      this.logger.warn(
        'shutdown timeout: in-flight messages will reappear after their visibility timeout',
      );
    this.loop = undefined;
    this.logger.log('stopped');
  }

  // ------------------------------------------------------------------ loop

  private async run(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stopping) {
      let messages: Message[];
      try {
        messages = await this.receive();
        consecutiveFailures = 0;
      } catch (error) {
        if (this.stopping) break;
        consecutiveFailures += 1;
        const delay = this.pollErrorBackoff.delayFor(consecutiveFailures);
        this.logger.warn(
          `receive failed (${(error as Error).message}); retrying in ${delay} ms`,
        );
        await sleep(delay);
        continue;
      }
      if (messages.length > 0) await this.processBatch(messages);
    }
  }

  private async receive(): Promise<Message[]> {
    this.receiveAbort = new AbortController();
    const output = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: MAX_BATCH_SIZE,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
      { abortSignal: this.receiveAbort.signal },
    );
    return output.Messages ?? [];
  }

  /** Mesmo MessageGroupId (= walletId) em sequência; grupos diferentes em paralelo. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group =
        message.Attributes?.MessageGroupId ?? message.MessageId ?? 'ungrouped';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map((group) => this.processGroup(group)),
    );
  }

  private async processGroup(messages: Message[]): Promise<void> {
    // cada mensagem tem seu contexto de log: o handler o enriquece (messageId, correlationId, walletId...)

    for (let i = 0; i < messages.length; i++) {
      if (this.stopping) {
        await this.release(messages.slice(i)); // não iniciadas: devolve para outra instância
        return;
      }
      const message = messages[i]!;
      const disposition = await runWithLogContext(
        {
          sqsMessageId: message.MessageId,
          receiveCount: receiveCountOf(message),
          queue: this.options.queueName,
        },
        async () => {
          const result = await this.dispatch(message);
          await this.apply(message, result);
          return result;
        },
      );
      await this.apply(message, disposition);

      if (disposition.action === 'retry') {
        // preserva a ordem do grupo: as seguintes voltam para a fila e vêm depois desta
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  private async dispatch(message: Message): Promise<MessageDisposition> {
    const receiveCount = receiveCountOf(message);
    const startedAt = performance.now();
    let disposition: MessageDisposition;
    try {
      disposition = await this.options.handle(message.Body ?? '');
    } catch (error) {
      disposition = {
        action: 'retry',
        reason: `handler threw: ${(error as Error).message}`,
      };
    } finally {
      this.options.metrics?.observe(
        'sqs_message_processing_duration_seconds',
        (performance.now() - startedAt) / 1000,
        { queue: this.options.queueName },
      );
    }

    if (
      disposition.action === 'retry' &&
      receiveCount >= this.options.maxReceiveCount
    ) {
      return {
        action: 'dead-letter',
        reason: 'RETRIES_EXHAUSTED',
        detail: disposition.reason,
      };
    }
    return disposition;
  }

  // ------------------------------------------------------------------ execução das decisões

  private async apply(
    message: Message,
    disposition: MessageDisposition,
  ): Promise<void> {
    try {
      switch (disposition.action) {
        case 'ack':
          await this.delete(message);
          this.logger.debug({
            event: 'sqs_message_acked',
            reason: disposition.reason,
          });
          break;
        case 'retry': {
          const delaySeconds = Math.min(
            Math.ceil(
              this.retryBackoff.delayFor(receiveCountOf(message)) / 1_000,
            ),
            MAX_VISIBILITY_TIMEOUT_SECONDS,
          );
          await this.changeVisibility(message, delaySeconds);
          this.options.metrics?.increment('sqs_message_retries_total', {
            queue: this.options.queueName,
          });
          this.logger.warn({
            event: 'sqs_message_retry',
            delaySeconds,
            reason: disposition.reason,
          });
          break;
        }
        case 'dead-letter':
          await this.sendToDeadLetterQueue(message, disposition);
          await this.delete(message);
          this.options.metrics?.increment('sqs_dead_letter_messages_total', {
            queue: this.options.queueName,
            reason: disposition.reason,
          });
          this.logger.error({
            event: 'sqs_message_dead_lettered',
            reason: disposition.reason,
            detail: disposition.detail,
          });
          break;
      }
    } catch (error) {
      // falha ao falar com o SQS: a mensagem reaparece após o visibility timeout,
      // e a inbox garante que a reentrega não repita o efeito
      this.logger.error({
        event: 'sqs_disposition_failed',
        action: disposition.action,
        error: (error as Error).message,
      });
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.changeVisibility(message, 0).catch(() => undefined),
      ),
    );
  }

  private delete(message: Message): Promise<unknown> {
    return this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private changeVisibility(
    message: Message,
    seconds: number,
  ): Promise<unknown> {
    return this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private sendToDeadLetterQueue(
    message: Message,
    disposition: Extract<MessageDisposition, { action: 'dead-letter' }>,
  ): Promise<unknown> {
    const text = (value: string) => ({
      DataType: 'String',
      StringValue: value,
    });
    return this.client.send(
      new SendMessageCommand({
        QueueUrl: this.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          'dlq-reason': text(disposition.reason),
          'dlq-detail': text(
            disposition.detail.slice(0, MAX_DLQ_DETAIL_LENGTH) || '-',
          ),
          'original-message-id': text(message.MessageId ?? '-'),
          'receive-count': {
            DataType: 'Number',
            StringValue: String(receiveCountOf(message)),
          },
        },
      }),
    );
  }

  private async resolveQueueUrl(queueName: string): Promise<string> {
    const output = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    if (!output.QueueUrl) throw new Error(`queue ${queueName} not found`);
    return output.QueueUrl;
  }
}

function receiveCountOf(message: Message): number {
  return Number(message.Attributes?.ApproximateReceiveCount ?? 1);
}
