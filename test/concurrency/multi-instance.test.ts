import { AppProcess, startAppProcess } from '@/test/support/app-process';
import {
  IsolatedDatabase,
  createIsolatedDatabase,
} from '@/test/support/database';
import {
  consumerEnv,
  createTestQueues,
  relayEnv,
  type TestQueues,
} from '@/test/support/sqs';
import {
  Operation,
  RequestFn,
  SubmitResult,
  walletClient,
} from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import { TestWallet } from '@/test/support/schema-fixtures';

const INSTANCES = 3;
const ITERATIONS = Number(process.env.CONCURRENCY_ITERATIONS ?? 10);

let db: IsolatedDatabase;
let queues: TestQueues;
let apps: AppProcess[] = [];
let api: ReturnType<typeof walletClient>;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  // no roles, every instance always consumes/publishes — isolate the queue here so
  // these 3 instances (this test is HTTP-only) don't touch the real dev queue.
  queues = await createTestQueues();
  const env = { ...consumerEnv(queues), ...relayEnv(queues) };
  apps = await Promise.all(
    Array.from({ length: INSTANCES }, () => startAppProcess(db.appUrl, env)),
  );
  api = walletClient(apps[0]!.request);
}, 60_000);

afterAll(async () => {
  if (db) expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);
  await Promise.all(apps.map((app) => app.stop()));
  await db?.drop();
  await queues?.drop();
}, 60_000);

/** Distributes requests round-robin across instances. */
function instance(i: number): RequestFn {
  return apps[i % apps.length]!.request;
}

function times<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

/** Fires the operations at the same time, each one through an instance (round-robin). */
function raceAcrossInstances(
  w: TestWallet,
  operations: Operation[],
): Promise<SubmitResult[]> {
  return Promise.all(operations.map((op, i) => api.submit(w, op, instance(i))));
}

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

async function debits(w: TestWallet): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    db.appUrl,
    `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [w.walletId],
  );
  return Number(row!.n);
}

describe(`${INSTANCES} instances (separate processes) over the same database`, () => {
  test('are distinct processes, each responding on its own port', async () => {
    expect(new Set(apps.map((a) => a.pid)).size).toBe(INSTANCES);
    expect(new Set(apps.map((a) => a.baseUrl)).size).toBe(INSTANCES);
    for (const app of apps) {
      expect((await app.request('/health/live')).status).toBe(200);
    }
  });

  test(`prompt scenario with each bet on a different instance, repeated ${ITERATIONS} times`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const w = await newWallet('100.00');
      const results = await raceAcrossInstances(w, [
        { kind: 'BET', amount: '80.00' },
        { kind: 'BET', amount: '80.00' },
      ]);

      expect(results.map((r) => r.body.status).sort()).toEqual([
        'PROCESSED',
        'REJECTED',
      ]);
      expect(await api.balanceOf(w)).toEqual({ amount: '20.00', version: 2 });
      expect(await debits(w)).toBe(1);
    }
  });

  test('the same bet 60 times, 20 per instance: a single debit', async () => {
    for (let i = 0; i < Math.ceil(ITERATIONS / 2); i++) {
      const w = await newWallet('100.00');
      const op: Operation = {
        kind: 'BET',
        amount: '10.00',
        externalId: crypto.randomUUID(),
      };
      const results = await raceAcrossInstances(
        w,
        times(60, () => op),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        results.filter((r) => r.body.idempotentReplay === false),
      ).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
      expect(await debits(w)).toBe(1);
    }
  });

  test('30 bets of 10.00 against 100.00 spread out: 10 accepted, unique observed balances', async () => {
    const w = await newWallet('100.00');
    const results = await raceAcrossInstances(
      w,
      times(30, () => ({ kind: 'BET', amount: '10.00' })),
    );

    const accepted = results.filter((r) => r.body.status === 'PROCESSED');
    expect(accepted).toHaveLength(10);
    expect(accepted.map((r) => r.body.balance.amount).sort()).toEqual([
      '0.00',
      '10.00',
      '20.00',
      '30.00',
      '40.00',
      '50.00',
      '60.00',
      '70.00',
      '80.00',
      '90.00',
    ]);
    expect(await api.balanceOf(w)).toEqual({ amount: '0.00', version: 11 });
  });

  test('simultaneous REFUNDs of the same BET, one per instance: only one refunds', async () => {
    const w = await newWallet('100.00');
    const bet = await api.submit(w, { kind: 'BET', amount: '40.00' });
    const results = await raceAcrossInstances(
      w,
      times(6, () => ({
        kind: 'REFUND',
        amount: '40.00',
        reference: bet.externalId,
      })),
    );

    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(
      1,
    );
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
  });

  test('simultaneous creation of the same wallet across different instances: one 201', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(
      times(9, (i) =>
        walletClient(instance(i)).openWallet('10.00', { playerId }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(8);
  });

  test('different wallets in parallel across the 3 instances: each one settles correctly', async () => {
    const wallets = await Promise.all(times(15, () => newWallet('100.00')));
    await Promise.all(
      wallets.flatMap((w, wi) =>
        times(4, (k) =>
          api.submit(w, { kind: 'BET', amount: '20.00' }, instance(wi + k)),
        ),
      ),
    );
    for (const w of wallets) {
      expect(await api.balanceOf(w)).toEqual({ amount: '20.00', version: 5 });
    }
  });

  test('what one instance writes, the others read (no in-memory state)', async () => {
    const w = await newWallet('100.00');
    const op: Operation = {
      kind: 'BET',
      amount: '15.00',
      externalId: crypto.randomUUID(),
    };

    const first = await api.submit(w, op, instance(0));
    const replayOnSecond = await api.submit(w, op, instance(1));
    const replayOnThird = await api.submit(w, op, instance(2));

    expect(first.body.idempotentReplay).toBe(false);
    expect(replayOnSecond.body).toEqual({
      ...first.body,
      idempotentReplay: true,
    });
    expect(replayOnThird.body).toEqual({
      ...first.body,
      idempotentReplay: true,
    });
  });
});
