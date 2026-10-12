import type { OutboxMessage } from '../../domain/outbox-message';

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}

export const OUTBOX_REPOSITORY = Symbol('OutboxRepository');
