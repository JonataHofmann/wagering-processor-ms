import { type AppProcess, startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import {
  connectPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import {
  consumerEnv,
  createTestQueues,
  type TestQueues,
  waitFor,
} from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let db: IsolatedDatabase;
let apiProcess: AppProcess; // API-only instance: creates and queries wallets, doesn't consume
let p: Persistence;
let api: ReturnType<typeof walletClient>;
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  db = await createIsolatedDatabase();
  apiProcess = await startAppProcess(db.appUrl);
  p = await connectPersistence(db);
  api = walletClient(apiProcess.request);
}, 60_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  if (db) expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);
  await p?.close();
  await apiProcess?.stop();
  await db?.drop();
}, 60_000);

/** Registers for cleanup at the end, even if the test fails midway. */
function track<
  T extends { stop?: () => Promise<void>; drop?: () => Promise<void> },
>(resource: T): T {
  cleanup.push(async () => {
    await resource.stop?.();
    await resource.drop?.();
  });
  return resource;
}

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

function message(w: TestWallet, amount = '25.00') {
  const externalTransactionId = crypto.randomUUID();
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

async function statusOf(idempotencyKey: string): Promise<string | undefined> {
  const [row] = await queryOnce<{ status: string }>(
    db.appUrl,
    `SELECT status FROM wager_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return row?.status;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(db.appUrl, sql, params);
  return Number(row!.n);
}

/** Locks the wallet from outside the application; returns the function that releases the lock. */
async function holdWalletLock(walletId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = p.tm.runInTransaction(async () => {
    await p.wallets.findByIdForUpdate(walletId);
    locked();
    await held;
  });
  await taken;
  return async () => {
    release();
    await holder;
  };
}

describe('consumer recovery', () => {
  test('process killed after commit and before ack: redelivery does not repeat the effect', async () => {
    const queues: TestQueues = track(
      await createTestQueues({
        visibilityTimeoutSeconds: 3,
        maxReceiveCount: 5,
      }),
    );
    const w = await newWallet('100.00');
    const msg = message(w);

    // 1. instance that dies (SIGKILL) right after the commit, before DeleteMessage
    const doomed = track(
      await startAppProcess(
        db.appUrl,
        consumerEnv(queues, {
          FAULT_INJECTION: 'crash-after-commit-before-ack',
        }),
      ),
    );
    await queues.send(msg, { groupId: w.walletId });
    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');

    // 2. the commit happened (debit, transaction, inbox)...
    expect(await statusOf(msg.data.idempotencyKey)).toBe('PROCESSED');
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
    // ...but the ack didn't: the message is still in the queue
    expect(await queues.depth()).toBe(1);

    // 3. another instance receives the redelivery (after the 3s visibility timeout)
    const survivor = track(
      await startAppProcess(db.appUrl, consumerEnv(queues)),
    );
    await waitFor(
      async () => (await queues.depth()) === 0,
      'redelivered message acked',
      20_000,
    );
    await survivor.stop();

    // 4. a single effect: nothing was debited again
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
    expect(
      await count(
        `SELECT count(*) AS n FROM wager_transactions WHERE idempotency_key = $1`,
        [msg.data.idempotencyKey],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM inbox_messages WHERE message_id = $1`,
        [msg.messageId],
      ),
    ).toBe(1);
    expect(await queues.deadLetters()).toHaveLength(0);
  }, 60_000);

  test('SIGTERM with a message in flight: finishes the current one and returns the ones not yet started', async () => {
    const queues: TestQueues = track(
      await createTestQueues({
        visibilityTimeoutSeconds: 15,
        maxReceiveCount: 5,
      }),
    );
    const w = await newWallet('100.00');
    const first = message(w, '10.00');
    const second = message(w, '20.00');

    const consumerA = track(
      await startAppProcess(db.appUrl, consumerEnv(queues)),
    );
    const releaseLock = await holdWalletLock(w.walletId); // the first message will be left waiting on the lock

    await queues.send(first, { groupId: w.walletId });
    await queues.send(second, { groupId: w.walletId });
    await Bun.sleep(700); // A received it and is processing the first one (blocked on the lock)

    const stopping = consumerA.stop(); // SIGTERM with the first one in flight
    await Bun.sleep(500);
    await releaseLock(); // now the first one can finish
    await stopping;

    // the in-flight message completed before the process exited
    expect(await statusOf(first.data.idempotencyKey)).toBe('PROCESSED');
    expect(consumerA.output()).toContain('stopped');

    // the one not yet started went back to the queue right away (visibility 0), not after the 15s visibility timeout
    const startedAt = Date.now();
    const consumerB = track(
      await startAppProcess(db.appUrl, consumerEnv(queues)),
    );
    await waitFor(
      async () => (await statusOf(second.data.idempotencyKey)) === 'PROCESSED',
      'second processed by B',
      10_000,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await consumerB.stop();

    expect(await api.balanceOf(w)).toEqual({ amount: '70.00', version: 3 });
  }, 60_000);

  test('persistent transient failure: after maxReceiveCount attempts, DLQ with RETRIES_EXHAUSTED', async () => {
    const queues: TestQueues = track(
      await createTestQueues({
        visibilityTimeoutSeconds: 10,
        maxReceiveCount: 3,
      }),
    );
    const w = await newWallet('100.00');
    const msg = message(w);

    const consumer = track(
      await startAppProcess(db.appUrl, consumerEnv(queues)),
    );
    const releaseLock = await holdWalletLock(w.walletId); // never released during the attempts

    await queues.send(msg, { groupId: w.walletId });
    await waitFor(
      async () => (await queues.deadLetters()).length > 0,
      'message in DLQ',
      40_000,
    );
    await releaseLock();
    await consumer.stop();

    const [dead] = await queues.deadLetters();
    expect(dead!.attributes['dlq-reason']?.StringValue).toBe(
      'RETRIES_EXHAUSTED',
    );
    expect(dead!.attributes['receive-count']?.StringValue).toBe('3');
    expect(dead!.attributes['dlq-detail']?.StringValue).toContain('transient');
    expect(JSON.parse(dead!.body).messageId).toBe(msg.messageId); // the original body, untouched

    // no attempt left a trace: no transaction, no inbox
    expect(await statusOf(msg.data.idempotencyKey)).toBeUndefined();
    expect(
      await count(
        `SELECT count(*) AS n FROM inbox_messages WHERE message_id = $1`,
        [msg.messageId],
      ),
    ).toBe(0);
    expect(await queues.depth()).toBe(0);
  }, 60_000);
});
