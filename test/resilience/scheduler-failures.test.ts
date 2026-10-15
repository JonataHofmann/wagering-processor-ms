import { type AppProcess, startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
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
// isolates the queue: every real process now always runs consumer and relay (no role
// to turn them off), and without this they'd be watching the REAL dev queue
let queues: TestQueues;
// IN-PROCESS app: creates the pending items and references via HTTP, but never
// resolves them — there's no natural gate like "SQS absent" for the scheduler (it
// always turns on), so the huge idleIntervalMs leaves it inert after the 1st round
// (empty, at boot, before any pending item exists); the real "scheduler" processes
// each test spins up below are the ones that resolve them.
let apiApp: TestApp;
let api: ReturnType<typeof walletClient>;
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  db = await createIsolatedDatabase();
  queues = await createTestQueues();
  apiApp = await startTestApp(
    {
      referenceLookup: { backoffBaseMs: 5_000, backoffMaxMs: 60_000, ttlMs: 900_000 },
      scheduler: { batchSize: 20, leaseMs: 10_000, idleIntervalMs: 3_600_000 },
    },
    db,
  );
  api = walletClient(apiApp.request);
}, 60_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  if (db) expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);
  await apiApp?.close();
  await queues?.drop();
  await db?.drop();
}, 60_000);

beforeEach(async () => {
  // pending items left over from a previous test can't take down the next test's scheduler
  await queryOnce(
    db.appUrl,
    `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE status = 'PENDING_REFERENCE'`,
  );
});

function track(process: AppProcess): AppProcess {
  cleanup.push(() => process.stop());
  return process;
}

async function statusOf(
  transactionId: string,
): Promise<{ status: string; next_attempt_at: Date | null }> {
  const [row] = await queryOnce<{
    status: string;
    next_attempt_at: Date | null;
  }>(
    db.appUrl,
    `SELECT status, next_attempt_at FROM wager_transactions WHERE id = $1`,
    [transactionId],
  );
  return row!;
}

/** Wallet with a pending REFUND; returns the external id of the BET it's waiting on. */
async function pendingRefund(w: TestWallet, amount = '10.00') {
  const betId = crypto.randomUUID();
  const refund = await api.submit(w, {
    kind: 'REFUND',
    amount,
    reference: betId,
  });
  expect(refund.status).toBe(202);
  return { refundId: refund.body.transactionId as string, betId };
}

describe('scheduler recovery', () => {
  test('scheduler killed after claiming: another instance resolves once the claim expires', async () => {
    // step 15 rule: the process with the fault injection comes up BEFORE the work that kills it exists
    const doomed = track(
      await startAppProcess(db.appUrl, {
        ...consumerEnv(queues),
        ...relayEnv(queues),
        ...schedulerEnv({
          FAULT_INJECTION: 'crash-after-claim-before-resolve',
        }),
      }),
    );

    const { wallet } = await api.openWallet('100.00');
    const { refundId, betId } = await pendingRefund(wallet, '40.00');
    await api.submit(wallet, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
    }); // shortcut: the pending item is due now

    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');

    // claimed by the dead process: still pending, with the claim still valid
    const reserved = await statusOf(refundId);
    expect(reserved.status).toBe('PENDING_REFERENCE');
    expect(reserved.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());

    const survivor = track(
      await startAppProcess(db.appUrl, {
        ...consumerEnv(queues),
        ...relayEnv(queues),
        ...schedulerEnv(),
      }),
    );
    await waitFor(
      async () => (await statusOf(refundId)).status === 'PROCESSED',
      'resolved after lease',
      20_000,
    );
    await survivor.stop();

    expect(await api.balanceOf(wallet)).toEqual({
      amount: '100.00',
      version: 3,
    });
  }, 60_000);

  test('3 schedulers in separate processes: 30 pending items, each resolved exactly once', async () => {
    const schedulers = await Promise.all(
      Array.from({ length: 3 }, () =>
        startAppProcess(db.appUrl, {
          ...consumerEnv(queues),
          ...relayEnv(queues),
          ...schedulerEnv(),
        }),
      ),
    );
    schedulers.forEach(track);

    // 10 wallets with 3 pending REFUNDs each (pending items on the same wallet compete for the same lock)
    const wallets = await Promise.all(
      Array.from(
        { length: 10 },
        async () => (await api.openWallet('100.00')).wallet,
      ),
    );
    const pendings = (
      await Promise.all(
        wallets.map(async (w) => {
          const items = [];
          for (let i = 0; i < 3; i++)
            items.push({ wallet: w, ...(await pendingRefund(w, '10.00')) });
          return items;
        }),
      )
    ).flat();

    // the BETs all arrive at once: 30 pending items come due together
    await Promise.all(
      pendings.map((p) =>
        api.submit(p.wallet, {
          kind: 'BET',
          amount: '10.00',
          externalId: p.betId,
        }),
      ),
    );

    await waitFor(
      async () => {
        const [row] = await queryOnce<{ n: string }>(
          db.appUrl,
          `SELECT count(*) AS n FROM wager_transactions WHERE id = ANY($1::uuid[]) AND status = 'PROCESSED'`,
          [pendings.map((p) => p.refundId)],
        );
        return Number(row!.n) === 30;
      },
      'all 30 resolved',
      30_000,
    );
    await Promise.all(schedulers.map((s) => s.stop()));

    // each REFUND credited exactly once: 100 - 3×10 (BETs) + 3×10 (REFUNDs) = 100
    for (const w of wallets) {
      expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 7 });
    }
    const [credits] = await queryOnce<{ n: string }>(
      db.appUrl,
      `SELECT count(*) AS n FROM wallet_ledger_entries WHERE transaction_id = ANY($1::uuid[])`,
      [pendings.map((p) => p.refundId)],
    );
    expect(credits!.n).toBe('30');
  }, 90_000);
});
