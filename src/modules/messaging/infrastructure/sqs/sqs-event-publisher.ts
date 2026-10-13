import {
  EventPublisher,
  PublishOutcome,
} from '@/src/modules/messaging/application/ports/event-publisher.port';
import { OutboxMessage } from '@/src/modules/messaging/domain/outbox-message';
import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

const MAX_BATCH = 10; // limite do SendMessageBatch

/**
 * Publica no wallet-events.fifo:
 * - MessageGroupId = aggregateId (walletId): ordem por wallet;
 * - MessageDeduplicationId = eventId: uma republicação dentro de 5 min é descartada pelo SQS
 *   (otimização; a garantia é o consumidor deduplicar pelo eventId);
 * - corpo = o envelope gravado na outbox, sem nenhuma transformação.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]> {
    const queueUrl = await this.resolveQueueUrl();
    const outcomes: PublishOutcome[] = [];

    for (let start = 0; start < messages.length; start += MAX_BATCH) {
      const chunk = messages.slice(start, start + MAX_BATCH);
      const output = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventVersion: {
                DataType: 'Number',
                StringValue: String(message.eventVersion),
              },
            },
          })),
        }),
      );

      const failures = new Map(
        (output.Failed ?? []).map((f) => [
          f.Id,
          `${f.Code ?? 'error'}: ${f.Message ?? ''}`,
        ]),
      );
      for (const message of chunk) {
        const error = failures.get(message.id);
        outcomes.push(
          error === undefined
            ? { id: message.id, ok: true }
            : { id: message.id, ok: false, error },
        );
      }
    }
    return outcomes;
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      const output = await this.client.send(
        new GetQueueUrlCommand({ QueueName: this.queueName }),
      );
      if (!output.QueueUrl)
        throw new Error(`queue ${this.queueName} not found`);
      this.queueUrl = output.QueueUrl;
    }
    return this.queueUrl;
  }
}
