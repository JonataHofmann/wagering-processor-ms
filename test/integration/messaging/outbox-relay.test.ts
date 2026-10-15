import {
  OutboxRelay,
  type OutboxRelayOptions,
} from '@/src/modules/messaging/application/use-cases/outbox-relay';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import { InMemoryMetrics } from '@/src/platform/observability/metrics';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { IntegrationEvent } from '@/src/shared/domain/integration-event';
import {
  createPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import { RecordingPublisher } from '@/test/support/recording-publisher';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

let p: Persistence;
let publisher: RecordingPublisher;

beforeAll(async () => {
  p = await createPersistence();
});
afterAll(async () => {
  await p?.close();
});

beforeEach(async () => {
  publisher = new RecordingPublisher();
  // each test starts with no pending events left over from previous tests
  await queryOnce(
    p.db.appUrl,
    `UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`,
  );
});

class TestEvent extends IntegrationEvent<{ sequence: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static of(sequence: number, occurredAt: Date): TestEvent {
    return new TestEvent({
      eventId: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      correlationId: 'corr',
      occurredAt,
      data: { sequence },
    });
  }
}

/** Writes n events to the outbox, with increasing occurredAt starting from the test clock. */
async function enqueue(n: number): Promise<OutboxMessage[]> {
  const base = p.clock.now().getTime();
  const messages = Array.from({ length: n }, (_, i) =>
    OutboxMessage.enqueue(TestEvent.of(i, new Date(base - n + i))),
  );
  await p.tm.runInTransaction(() => p.outbox.enqueue(messages));
  return messages;
}

function relay(
  overrides: Partial<OutboxRelayOptions> = {},
  pub: RecordingPublisher = publisher,
): OutboxRelay {
  return new OutboxRelay(p.tm, p.outbox, pub, p.clock, {
    owner: `relay-${crypto.randomUUID().slice(0, 8)}`,
    batchSize: 10,
    leaseMs: 30_000,
    backoff: new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'none',
    }),
    ...overrides,
  });
}

async function row(id: string) {
  const [r] = await queryOnce<{
    published_at: Date | null;
    attempts: number;
    next_attempt_at: Date;
    locked_by: string | null;
    last_error: string | null;
  }>(
    p.db.appUrl,
    `SELECT published_at, attempts, next_attempt_at, locked_by, last_error FROM outbox_messages WHERE id = $1`,
    [id],
  );
  return r!;
}

describe('publishing', () => {
  test('publishes pending messages in occurrence order and marks them as published', async () => {
    const messages = await enqueue(5);
    const round = await relay().relayOnce();

    expect(round).toEqual({ claimed: 5, published: 5, failed: 0 });
    expect(publisher.published.map((e) => e.id)).toEqual(
      messages.map((m) => m.id),
    );
    for (const m of messages) {
      const r = await row(m.id);
      expect(r.published_at).not.toBeNull();
      expect(r.locked_by).toBeNull(); // lease released
    }
  });

  test('a published message is not published again', async () => {
    await enqueue(3);
    await relay().relayOnce();
    expect(await relay().relayOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    expect(publisher.published).toHaveLength(3);
  });

  test('the published payload is the envelope stored in the transaction', async () => {
    const [m] = await enqueue(1);
    await relay().relayOnce();
    expect(publisher.published[0]!.payload).toEqual(
      m!.payload as Record<string, unknown>,
    );
  });

  test('records outbox_publish_lag_seconds (gauge) after publishing', async () => {
    const metrics = new InMemoryMetrics();
    await enqueue(3); // occurredAt in the past: lag > 0 when publishing now
    await relay({ metrics }).relayOnce();

    expect(metrics.value('outbox_publish_lag_seconds')).toBeGreaterThan(0);
  });
});

describe('concurrent relays', () => {
  test('4 relays contending for 200 events: each event published exactly once', async () => {
    const messages = await enqueue(200);
    publisher.delayMs = 5; // widens the window between claiming and marking
    const relays = Array.from({ length: 4 }, () => relay());

    // each relay runs rounds until nothing is left
    await Promise.all(
      relays.map(async (r) => {
        while ((await r.relayOnce()).claimed > 0) {
          /* continue */
        }
      }),
    );

    expect(publisher.published).toHaveLength(200);
    expect(new Set(publisher.published.map((e) => e.id)).size).toBe(200);
    for (const m of messages) expect(publisher.countOf(m.id)).toBe(1);
  });

  test('the batch claimed by one relay is invisible to others while the lease holds', async () => {
    await enqueue(3);
    const claimed = await p.tm.runInTransaction(() =>
      p.outbox.claimDue({
        now: p.clock.now(),
        leaseMs: 30_000,
        limit: 10,
        owner: 'relay-que-travou',
      }),
    );
    expect(claimed).toHaveLength(3);

    expect(await relay().relayOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });
  });
});

describe('failures', () => {
  test('relay dies after claiming: once the lease expires, another relay takes over', async () => {
    const [m] = await enqueue(1);
    // claims and "dies": never publishes nor marks
    await p.tm.runInTransaction(() =>
      p.outbox.claimDue({
        now: p.clock.now(),
        leaseMs: 30_000,
        limit: 10,
        owner: 'relay-morto',
      }),
    );

    expect((await relay().relayOnce()).claimed).toBe(0); // lease still holds

    p.clock.advance(30_001);
    expect(await relay().relayOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(publisher.countOf(m!.id)).toBe(1);
  });

  test('dies after publishing and before marking: the event is published again (at-least-once), with the same eventId', async () => {
    const [m] = await enqueue(1);
    const crashing = relay({
      afterPublish: () => {
        throw new Error('process died after publish');
      },
    });

    await expect(crashing.relayOnce()).rejects.toThrow(
      'process died after publish',
    );
    expect(publisher.countOf(m!.id)).toBe(1);
    expect((await row(m!.id)).published_at).toBeNull(); // published on the broker, but not marked

    p.clock.advance(30_001); // dead relay's lease expires
    await relay().relayOnce();

    expect(publisher.countOf(m!.id)).toBe(2); // duplicate: the consumer deduplicates by eventId
    const [first, second] = publisher.published.filter((e) => e.id === m!.id);
    expect(second!.payload).toEqual(first!.payload as Record<string, unknown>);
    expect((await row(m!.id)).published_at).not.toBeNull();
  });

  test('publish failure: attempts, backoff and error recorded; republishes once due', async () => {
    const [m] = await enqueue(1);
    publisher.failNext.add(m!.id);

    expect(await relay().relayOnce()).toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    const failed = await row(m!.id);
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toBe('simulated failure');
    expect(failed.locked_by).toBeNull();
    expect(failed.next_attempt_at.getTime()).toBe(
      p.clock.now().getTime() + 1_000,
    );

    expect((await relay().relayOnce()).claimed).toBe(0); // not yet due
    p.clock.advance(1_000);
    expect(await relay().relayOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
  });

  test('partial batch failure: only the ones that failed remain pending', async () => {
    const messages = await enqueue(4);
    publisher.failNext.add(messages[1]!.id);
    publisher.failNext.add(messages[3]!.id);

    expect(await relay().relayOnce()).toEqual({
      claimed: 4,
      published: 2,
      failed: 2,
    });
    expect((await row(messages[0]!.id)).published_at).not.toBeNull();
    expect((await row(messages[1]!.id)).published_at).toBeNull();
  });

  test('broker down: the entire batch enters backoff, with increasing intervals', async () => {
    const [m] = await enqueue(1);
    publisher.outage = 'connection refused';

    for (const expectedDelay of [1_000, 2_000, 4_000]) {
      await relay().relayOnce();
      const r = await row(m!.id);
      expect(r.next_attempt_at.getTime() - p.clock.now().getTime()).toBe(
        expectedDelay,
      );
      p.clock.advance(expectedDelay);
    }
    expect((await row(m!.id)).attempts).toBe(3);

    publisher.outage = undefined; // broker comes back
    expect(await relay().relayOnce()).toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
    });
  });
});
