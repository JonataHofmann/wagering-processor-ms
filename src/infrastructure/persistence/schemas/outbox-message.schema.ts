import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    eventVersion: { type: 'integer' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    lockedUntil: { type: 'datetime', nullable: true },
    lockedBy: { type: 'string', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
    lastError: { type: 'string', nullable: true },
  },
});
