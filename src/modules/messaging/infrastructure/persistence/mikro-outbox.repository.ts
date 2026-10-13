import {
  ClaimRequest,
  OutboxRepository,
} from '@/src/modules/messaging/application/ports/outbox.repository';

import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { OutboxMessageSchema } from '@/src/infrastructure/persistence/schemas/outbox-message.schema';
import { OutboxMessage } from '@/src/modules/messaging/domain/outbox-message';
import { OutboxMessageMapper } from '@/src/modules/messaging/infrastructure/persistence/messaging.mapper';

/** Linha crua devolvida pelo SQL explícito (colunas em snake_case). */
interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

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

  async claimDue({
    now,
    leaseMs,
    limit,
    owner,
  }: ClaimRequest): Promise<OutboxMessage[]> {
    // SQL explícito: FOR UPDATE SKIP LOCKED e UPDATE ... RETURNING num único comando.
    // O SELECT interno usa o índice parcial ix_outbox_due (published_at IS NULL).
    const rows = await this.context.current().execute<OutboxRow[]>(
      `UPDATE outbox_messages
          SET locked_until = ?, locked_by = ?
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY occurred_at, id
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, aggregate_id, event_type, event_version, payload, occurred_at,
                  attempts, next_attempt_at, published_at, last_error`,
      [new Date(now.getTime() + leaseMs), owner, now, now, limit],
    );

    return (
      rows
        .map((row) =>
          OutboxMessage.rehydrate({
            id: row.id,
            aggregateId: row.aggregate_id,
            eventType: row.event_type,
            eventVersion: row.event_version,
            payload: row.payload,
            occurredAt: new Date(row.occurred_at),
            attempts: row.attempts,
            nextAttemptAt: new Date(row.next_attempt_at),
            publishedAt: row.published_at
              ? new Date(row.published_at)
              : undefined,
            lastError: row.last_error ?? undefined,
          }),
        )
        // o RETURNING não garante ordem: reordena pela ocorrência
        .sort(
          (a, b) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            a.id.localeCompare(b.id),
        )
    );
  }

  async markPublished(message: OutboxMessage): Promise<boolean> {
    const affected = await this.context.current().nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        publishedAt: message.publishedAt ?? null,
        lockedUntil: null,
        lockedBy: null,
      },
    );
    return affected === 1;
  }

  async recordFailure(message: OutboxMessage): Promise<void> {
    await this.context.current().nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        lastError: message.lastError ?? null,
        lockedUntil: null,
        lockedBy: null,
      },
    );
  }
}
