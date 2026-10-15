import { describe, expect, test } from 'bun:test';

import { OUTBOX_RETRY_BACKOFF } from '@/src/modules/messaging/domain/outbox-message.constants';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { IntegrationEvent } from '@/src/shared/domain/integration-event';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** Minimal event to test the outbox without depending on business events. */
class TestEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = 'TestEvent';
  readonly version = 2;

  static of(occurredAt: Date = T0): TestEvent {
    return new TestEvent({
      eventId: 'evt-1',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt,
      data: { value: 'x' },
    });
  }
}

/** 1s, 2s, 4s ... ceiling 60s, no randomness. */
const exact = new ExponentialBackoff({
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 'none',
});

describe('enqueue', () => {
  test('copies identity, type and version of the event', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    expect(message).toMatchObject({
      id: 'evt-1',
      aggregateId: 'wallet-1',
      eventType: 'TestEvent',
      eventVersion: 2,
    });
    expect(message.occurredAt).toEqual(T0);
  });

  test('the payload is the event envelope, frozen', () => {
    const event = TestEvent.of();
    const message = OutboxMessage.enqueue(event);
    expect(message.payload).toEqual(
      event.toJSON() as unknown as Record<string, unknown>,
    );
    expect(Object.isFrozen(message.payload)).toBe(true);
  });

  test('starts pending, with no attempts, and due at the moment of the event', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.nextAttemptAt).toEqual(T0);
  });
});

describe('isDue', () => {
  test('false before nextAttemptAt, true at the exact instant and after', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(T0, { backoff: exact }); // next at T0 + 1s

    expect(message.isDue(at(999))).toBe(false);
    expect(message.isDue(at(1_000))).toBe(true);
    expect(message.isDue(at(5_000))).toBe(true);
  });

  test('published event is never due', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(999_999))).toBe(false);
  });

  test('freshly enqueued event is already due', () => {
    expect(OutboxMessage.enqueue(TestEvent.of()).isDue(T0)).toBe(true);
  });
});

describe('scheduleRetry with backoff', () => {
  test('each failure increments attempts and schedules from the moment of failure', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());

    message.scheduleRetry(at(0), { backoff: exact });
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1_000));

    message.scheduleRetry(at(1_000), { backoff: exact });
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(at(3_000)); // 1s + 2s

    message.scheduleRetry(at(3_000), { backoff: exact });
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(at(7_000)); // 3s + 4s
  });

  test('right after rescheduling, the event is not due', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(at(0), { backoff: exact });
    expect(message.isDue(at(0))).toBe(false);
  });

  test('stores the error of the last attempt, truncated to 500 characters', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(at(0), { backoff: exact, error: 'x'.repeat(800) });
    expect(message.lastError).toHaveLength(500);

    message.scheduleRetry(at(1_000), { backoff: exact, error: 'SQS timeout' });
    expect(message.lastError).toBe('SQS timeout');
  });
});

describe('backoff ceiling', () => {
  test('after many failures, the interval stays stuck at the ceiling', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    let now = T0;
    const waits: number[] = [];

    for (let i = 0; i < 12; i++) {
      message.scheduleRetry(now, { backoff: exact });
      waits.push(message.nextAttemptAt.getTime() - now.getTime());
      now = message.nextAttemptAt;
    }

    expect(waits).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000, // grows
      60_000,
      60_000,
      60_000,
      60_000,
      60_000,
      60_000, // stuck at the ceiling
    ]);
  });

  test('no limit on attempts: a confirmed event is never discarded', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    for (let i = 0; i < 1_000; i++)
      message.scheduleRetry(at(i), { backoff: exact });
    expect(message.attempts).toBe(1_000);
    expect(message.isPending()).toBe(true);
  });

  test('the default policy ranges from ~1s to 5min', () => {
    expect(OUTBOX_RETRY_BACKOFF.ceilingFor(1)).toBe(1_000);
    expect(OUTBOX_RETRY_BACKOFF.ceilingFor(50)).toBe(300_000);

    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(T0); // uses the default policy, with jitter
    const wait = message.nextAttemptAt.getTime() - T0.getTime();
    expect(wait).toBeGreaterThanOrEqual(500);
    expect(wait).toBeLessThanOrEqual(1_000);
  });
});

describe('publishing', () => {
  test('marking as published twice is a bug', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(() => message.markPublished(at(20))).toThrow(
      InvariantViolationError,
    );
    expect(message.publishedAt).toEqual(at(10));
  });

  test('rescheduling an already published event is a bug', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(() => message.scheduleRetry(at(20), { backoff: exact })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('rehydrate', () => {
  test('restores state and continues counting attempts', () => {
    const message = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'wallet-9',
      eventType: 'TestEvent',
      eventVersion: 1,
      payload: {},
      occurredAt: T0,
      attempts: 4,
      nextAttemptAt: at(30_000),
      lastError: 'falha anterior',
    });
    expect(message.isDue(at(29_999))).toBe(false);

    message.scheduleRetry(at(30_000), { backoff: exact });
    expect(message.attempts).toBe(5);
    expect(message.nextAttemptAt).toEqual(at(30_000 + 16_000)); // 5th attempt: 16s
  });
});
