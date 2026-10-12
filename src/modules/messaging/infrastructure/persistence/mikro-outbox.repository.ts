import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { OutboxMessageSchema } from '@/src/infrastructure/persistence/schemas/outbox-message.schema';
import { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { OutboxMessage } from '@/src/modules/messaging/domain/outbox-message';
import { OutboxMessageMapper } from '@/src/modules/messaging/infrastructure/persistence/messaging.mapper';

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.context
      .current()
      .insertMany(
        OutboxMessageSchema,
        messages.map(OutboxMessageMapper.toRecord),
      );
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.context
      .current()
      .findOne(OutboxMessageSchema, { id });
    return record ? OutboxMessageMapper.toDomain(record) : undefined;
  }
}
