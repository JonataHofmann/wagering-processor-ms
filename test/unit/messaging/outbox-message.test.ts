import { describe, expect, test } from 'bun:test';

import { OUTBOX_RETRY_BACKOFF } from '@/src/modules/messaging/domain/outbox-message.constants';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { IntegrationEvent } from '@/src/shared/domain/integration-event';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** Evento mínimo para testar a outbox sem depender dos eventos de negócio. */
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

/** 1 s, 2 s, 4 s ... teto 60 s, sem aleatoriedade. */
const exact = new ExponentialBackoff({
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 'none',
});

describe('enqueue', () => {
  test('copia identidade, tipo e versão do evento', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    expect(message).toMatchObject({
      id: 'evt-1',
      aggregateId: 'wallet-1',
      eventType: 'TestEvent',
      eventVersion: 2,
    });
    expect(message.occurredAt).toEqual(T0);
  });

  test('o payload é o envelope do evento, congelado', () => {
    const event = TestEvent.of();
    const message = OutboxMessage.enqueue(event);
    expect(message.payload).toEqual(
      event.toJSON() as unknown as Record<string, unknown>,
    );
    expect(Object.isFrozen(message.payload)).toBe(true);
  });

  test('nasce pendente, sem tentativas, e vencido no momento do evento', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.nextAttemptAt).toEqual(T0);
  });
});

describe('isDue', () => {
  test('falso antes de nextAttemptAt, verdadeiro no instante exato e depois', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(T0, { backoff: exact }); // próxima em T0 + 1 s

    expect(message.isDue(at(999))).toBe(false);
    expect(message.isDue(at(1_000))).toBe(true);
    expect(message.isDue(at(5_000))).toBe(true);
  });

  test('evento publicado nunca está vencido', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(999_999))).toBe(false);
  });

  test('evento recém-enfileirado já está vencido', () => {
    expect(OutboxMessage.enqueue(TestEvent.of()).isDue(T0)).toBe(true);
  });
});

describe('scheduleRetry com backoff', () => {
  test('cada falha incrementa attempts e agenda a partir do momento da falha', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());

    message.scheduleRetry(at(0), { backoff: exact });
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1_000));

    message.scheduleRetry(at(1_000), { backoff: exact });
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(at(3_000)); // 1 s + 2 s

    message.scheduleRetry(at(3_000), { backoff: exact });
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(at(7_000)); // 3 s + 4 s
  });

  test('logo depois de reagendar, o evento não está vencido', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(at(0), { backoff: exact });
    expect(message.isDue(at(0))).toBe(false);
  });

  test('guarda o erro da última tentativa, truncado em 500 caracteres', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(at(0), { backoff: exact, error: 'x'.repeat(800) });
    expect(message.lastError).toHaveLength(500);

    message.scheduleRetry(at(1_000), { backoff: exact, error: 'SQS timeout' });
    expect(message.lastError).toBe('SQS timeout');
  });
});

describe('teto do backoff', () => {
  test('depois de muitas falhas, o intervalo fica preso no teto', () => {
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
      32_000, // cresce
      60_000,
      60_000,
      60_000,
      60_000,
      60_000,
      60_000, // preso no teto
    ]);
  });

  test('sem limite de tentativas: evento confirmado nunca é descartado', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    for (let i = 0; i < 1_000; i++)
      message.scheduleRetry(at(i), { backoff: exact });
    expect(message.attempts).toBe(1_000);
    expect(message.isPending()).toBe(true);
  });

  test('a política padrão vai de ~1 s até 5 min', () => {
    expect(OUTBOX_RETRY_BACKOFF.ceilingFor(1)).toBe(1_000);
    expect(OUTBOX_RETRY_BACKOFF.ceilingFor(50)).toBe(300_000);

    const message = OutboxMessage.enqueue(TestEvent.of());
    message.scheduleRetry(T0); // usa a política padrão, com jitter
    const wait = message.nextAttemptAt.getTime() - T0.getTime();
    expect(wait).toBeGreaterThanOrEqual(500);
    expect(wait).toBeLessThanOrEqual(1_000);
  });
});

describe('publicação', () => {
  test('marcar como publicado duas vezes é bug', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(() => message.markPublished(at(20))).toThrow(
      InvariantViolationError,
    );
    expect(message.publishedAt).toEqual(at(10));
  });

  test('reagendar um evento já publicado é bug', () => {
    const message = OutboxMessage.enqueue(TestEvent.of());
    message.markPublished(at(10));
    expect(() => message.scheduleRetry(at(20), { backoff: exact })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('rehydrate', () => {
  test('restaura o estado e continua a contagem de tentativas', () => {
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
    expect(message.nextAttemptAt).toEqual(at(30_000 + 16_000)); // 5ª tentativa: 16 s
  });
});
