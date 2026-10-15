import { startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { queryOnce } from '@/test/support/pg';
import {
  consumerEnv,
  createTestQueues,
  relayEnv,
  schedulerEnv,
  type TestQueues,
  waitFor,
} from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

let db: IsolatedDatabase;
// IN-PROCESS app (not a real `bun src/main.ts`): without `sqs:`, relay/consumer
// stay inert on their own — it only generates outbox events via HTTP, never publishes
// them, never competes with the real "relay" processes each test spins up below.
let apiApp: TestApp;
let api: ReturnType<typeof walletClient>;
const cleanup: Array<() => Promise<unknown>> = [];

/**
 * Env for a real process dedicated to the relay: isolates the input queue (this instance's
 * consumer always runs, there's no role to turn it off) and leaves the scheduler practically
 * stopped (huge idleIntervalMs) — without this, the scheduler queries wager_transactions every
 * 500ms in each process, competing for connection/CPU with walletWithBet()'s two sequential
 * HTTP calls and widening the window where the relay can claim a partial batch.
 */
function relayProcessEnv(
  queues: TestQueues,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...consumerEnv(queues),
    ...relayEnv(queues, extra),
    ...schedulerEnv({ SCHEDULER_IDLE_INTERVAL_MS: '3600000' }),
  };
}

beforeAll(async () => {
  db = await createIsolatedDatabase();
  apiApp = await startTestApp({}, db);
  api = walletClient(apiApp.request);
}, 60_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  await apiApp?.close();
  await db?.drop();
}, 60_000);

beforeEach(async () => {
  // each test starts with an empty outbox: a test that failed midway doesn't leave
  // pending events for the next test's relays
  await queryOnce(
    db.appUrl,
    `UPDATE outbox_messages SET published_at = now(), locked_until = NULL, locked_by = NULL WHERE published_at IS NULL`,
  );
});

function track<
  T extends { stop?: () => Promise<void>; drop?: () => Promise<void> },
>(resource: T): T {
  cleanup.push(async () => {
    await resource.stop?.();
    await resource.drop?.();
  });
  return resource;
}

interface OutboxRow {
  id: string;
  published_at: Date | null;
  locked_by: string | null;
}

async function outboxOf(walletIds: string[]): Promise<OutboxRow[]> {
  return queryOnce<OutboxRow>(
    db.appUrl,
    `SELECT id, published_at, locked_by FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) ORDER BY occurred_at, id`,
    [walletIds],
  );
}

/** Creates the wallet and places a bet: 4 events committed to the outbox (opening + bet). */
async function walletWithBet(): Promise<TestWallet> {
  const { wallet } = await api.openWallet('100.00');
  await api.submit(wallet, { kind: 'BET', amount: '10.00' });
  return wallet;
}

/** Ids of received events that belong to the given wallets (ignores any other). */
function eventIdsOf(
  events: Array<{ body: Record<string, any> }>,
  walletIds: string[],
): Set<string> {
  const wallets = new Set(walletIds);
  return new Set(
    events
      .filter((e) => wallets.has(e.body.aggregateId))
      .map((e) => e.body.eventId as string),
  );
}

describe('relay recovery', () => {
  test('confirmed commit, relay dies before publishing: another instance takes over and publishes', async () => {
    const queues: TestQueues = track(await createTestQueues());

    // the relay comes up with an empty outbox (passes the health check) and waits for work.
    // A high OUTBOX_IDLE_INTERVAL_MS (1.5s) is deliberate: opening and betting, in walletWithBet(),
    // are 2 sequential HTTP transactions, not one — a short idle would let the relay risk
    // catching the 1st poll right in the middle of the two, claiming only half the batch (2 of 4
    // events) and dying with the rest orphaned (created only afterward, with no one to claim them).
    // An idle much longer than the time of the 2 calls guarantees that the 2nd round (not the 1st,
    // which finds the outbox still empty) always finds the whole batch already committed.
    const doomed = track(
      await startAppProcess(
        db.appUrl,
        relayProcessEnv(queues, {
          FAULT_INJECTION: 'crash-after-claim-before-publish',
          OUTBOX_IDLE_INTERVAL_MS: '1500',
        }),
      ),
    );

    // 1. PostgreSQL confirms the commit (events in the outbox)
    const w = await walletWithBet();

    // 2. the relay claims the batch and dies before publishing
    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');

    const reserved = await outboxOf([w.walletId]);
    expect(reserved).toHaveLength(4);
    expect(reserved.every((r) => r.published_at === null)).toBe(true);
    expect(reserved.every((r) => r.locked_by !== null)).toBe(true); // batch stuck under the dead relay's lease
    expect(eventIdsOf(await queues.drainEvents(), [w.walletId]).size).toBe(0); // nothing reached the broker

    // 3. another instance takes over once the lease (2s) expires, and 4. publishes
    const survivor = track(
      await startAppProcess(db.appUrl, relayProcessEnv(queues)),
    );
    await waitFor(
      async () =>
        (await outboxOf([w.walletId])).every((r) => r.published_at !== null),
      'events published',
      20_000,
    );
    await survivor.stop();

    expect(eventIdsOf(await queues.drainEvents(), [w.walletId])).toEqual(
      new Set(reserved.map((r) => r.id)),
    );
  }, 60_000);

  test('relay dies after publishing and before marking: republishing is safe (same eventId)', async () => {
    const queues: TestQueues = track(await createTestQueues());

    const doomed = track(
      await startAppProcess(
        db.appUrl,
        relayProcessEnv(queues, {
          FAULT_INJECTION: 'crash-after-publish-before-mark',
          OUTBOX_IDLE_INTERVAL_MS: '1500', // see comment on the previous test
        }),
      ),
    );
    const w = await walletWithBet();

    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');
    expect(
      (await outboxOf([w.walletId])).every((r) => r.published_at === null),
    ).toBe(true); // published, didn't mark

    const survivor = track(
      await startAppProcess(db.appUrl, relayProcessEnv(queues)),
    );
    await waitFor(
      async () =>
        (await outboxOf([w.walletId])).every((r) => r.published_at !== null),
      'events marked',
      20_000,
    );
    await survivor.stop();

    // republished with the same MessageDeduplicationId (= eventId): SQS FIFO drops the copy,
    // and even if it didn't, the consumer would deduplicate by eventId
    const events = await queues.drainEvents();
    expect(eventIdsOf(events, [w.walletId])).toEqual(
      new Set((await outboxOf([w.walletId])).map((r) => r.id)),
    );
    expect(events.every((e) => e.deduplicationId === e.body.eventId)).toBe(
      true,
    );
  }, 60_000);

  test('3 relays in separate processes: all events published, none lost', async () => {
    const queues: TestQueues = track(await createTestQueues());
    const wallets = await Promise.all(
      Array.from({ length: 15 }, () => walletWithBet()),
    ); // 60 events
    const walletIds = wallets.map((w) => w.walletId);

    const relays = await Promise.all(
      Array.from({ length: 3 }, () =>
        startAppProcess(db.appUrl, relayProcessEnv(queues)),
      ),
    );
    relays.forEach((r) => track(r));

    const allIds = (await outboxOf(walletIds)).map((r) => r.id);
    expect(allIds).toHaveLength(60);

    await waitFor(
      async () =>
        (await outboxOf(walletIds)).every((r) => r.published_at !== null),
      'all published',
      30_000,
    );
    await Promise.all(relays.map((r) => r.stop()));

    expect(eventIdsOf(await queues.drainEvents(), walletIds)).toEqual(
      new Set(allIds),
    );
  }, 90_000);
});
