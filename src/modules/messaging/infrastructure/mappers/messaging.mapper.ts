import { InboxMessageRecord } from '@/src/infrastructure/persistence/schemas/inbox-message.schema';
import { OutboxMessageRecord } from '@/src/infrastructure/persistence/schemas/outbox-message.schema';
import { InboxMessage } from '@/src/modules/messaging/domain/entities/inbox-message';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';

export const InboxMessageMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },
};

export const OutboxMessageMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      eventVersion: r.eventVersion,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      publishedAt: r.publishedAt ?? undefined,
      lastError: r.lastError ?? undefined,
    });
  },

  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      eventVersion: m.eventVersion,
      payload: { ...m.payload },
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt,
      lockedUntil: null,
      lockedBy: null,
      publishedAt: m.publishedAt ?? null,
      lastError: m.lastError ?? null,
    };
  },
};
