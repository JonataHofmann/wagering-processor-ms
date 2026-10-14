import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { InboxMessageSchema } from '@/src/infrastructure/persistence/schemas/inbox-message.schema';
import { InboxRepository } from '@/src/modules/messaging/application/ports/inbox.repository';
import { InboxMessage } from '@/src/modules/messaging/domain/entities/inbox-message';
import { InboxMessageMapper } from '@/src/modules/messaging/infrastructure/mappers/messaging.mapper';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async tryRegister(message: InboxMessage): Promise<boolean> {
    // SQL explícito: o ON CONFLICT é a deduplicação entre instâncias, e não lança erro
    // (um erro abortaria a transação inteira).
    const rows = await this.context
      .current()
      .execute<Array<{ message_id: string }>>(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
        [
          message.consumerName,
          message.messageId,
          message.payloadHash,
          message.receivedAt,
        ],
      );
    return rows.length === 1;
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const record = await this.context
      .current()
      .findOne(InboxMessageSchema, { consumerName, messageId });
    return record ? InboxMessageMapper.toDomain(record) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    if (!message.processedAt) {
      throw new InvariantViolationError(
        `inbox message ${message.messageId} has no processedAt`,
      );
    }
    const affected = await this.context
      .current()
      .nativeUpdate(
        InboxMessageSchema,
        { consumerName: message.consumerName, messageId: message.messageId },
        { processedAt: message.processedAt },
      );
    if (affected !== 1) {
      throw new InvariantViolationError(
        `inbox message ${message.messageId} not registered`,
      );
    }
  }
}
