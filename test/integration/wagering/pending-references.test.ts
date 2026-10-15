import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { ResolvePendingReferenceUseCase } from '@/src/modules/wagering/application/use-cases/resolve-pending-reference.use-case';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import {
  type Operation,
  type TestWallet,
  walletClient,
} from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

// short times: the test doesn't wait 15 minutes to prove expiration
const LOOKUP = { backoffBaseMs: 100, backoffMaxMs: 400, ttlMs: 1_500 };

let t: TestApp;
let api: ReturnType<typeof walletClient>;
let resolver: ResolvePendingReferenceUseCase;
let transactions: WagerTransactionRepository;
let tm: TransactionManager;

beforeAll(async () => {
  // this file tests resolver/claimDuePendingReferences directly, never via
  // the scheduler itself (that's pending-reference-scheduler.test.ts). Without roles,
  // this app's scheduler runs on its own in the background — a huge idleIntervalMs
  // keeps it from competing for the same pending references the tests reserve manually
  // (the 1st round runs empty on boot, before any pending reference exists).
  t = await startTestApp({
    referenceLookup: LOOKUP,
    scheduler: { batchSize: 20, leaseMs: 10_000, idleIntervalMs: 3_600_000 },
  });
  api = walletClient(t.request);
  resolver = t.app.get(ResolvePendingReferenceUseCase);
  transactions = t.app.get<WagerTransactionRepository>(
    WAGER_TRANSACTION_REPOSITORY,
  );
  tm = t.app.get<TransactionManager>(TRANSACTION_MANAGER);
});

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await t?.close();
});

interface Row {
  id: string;
  status: string;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  reference_transaction_id: string | null;
}

async function rowOf(transactionId: string): Promise<Row> {
  const [row] = await queryOnce<Row>(
    t.db.appUrl,
    `SELECT id, status, failure_code, attempts, next_attempt_at, reference_transaction_id
       FROM wager_transactions WHERE id = $1`,
    [transactionId],
  );
  return row!;
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await queryOnce<{ event_type: string }>(
    t.db.appUrl,
    `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY occurred_at, event_type`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

/** Sends an operation that references an external id that doesn't exist yet. */
async function early(w: TestWallet, op: Operation) {
  const result = await api.submit(w, op);
  expect(result.status).toBe(202);
  expect(result.body.status).toBe('PENDING_REFERENCE');
  return result;
}

describe('resolution of out-of-order references', () => {
  test('REFUND before the BET: reschedules while missing, resolves when the BET arrives', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });

    // the BET hasn't arrived yet: new attempt with backoff, no new event
    expect(await resolver.execute(refund.body.transactionId)).toBe(
      'rescheduled',
    );
    const waiting = await rowOf(refund.body.transactionId);
    expect(waiting.attempts).toBe(1);
    expect(waiting.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    // the BET arrives: debits and brings forward the pending reference waiting for it
    const bet = await api.submit(w, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
    });
    expect(bet.status).toBe(200);
    expect(
      (await rowOf(refund.body.transactionId)).next_attempt_at!.getTime(),
    ).toBeLessThanOrEqual(Date.now());

    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved');
    const resolved = await rowOf(refund.body.transactionId);
    expect(resolved.status).toBe('PROCESSED');
    expect(resolved.reference_transaction_id).toBe(bet.body.transactionId);
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('ROLLBACK of a WIN before the WIN: resolved as a debit when the WIN arrives', async () => {
    const w = await newWallet('10.00');
    const winId = crypto.randomUUID();
    const rollback = await early(w, {
      kind: 'ROLLBACK',
      amount: '30.00',
      reference: winId,
    });

    await api.submit(w, { kind: 'WIN', amount: '30.00', externalId: winId }); // 10 → 40
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'resolved',
    ); // 40 → 10
    expect((await rowOf(rollback.body.transactionId)).status).toBe('PROCESSED');
    expect(await api.balanceOf(w)).toEqual({ amount: '10.00', version: 3 });
  });

  test("the reference arrives, but doesn't match: resolved as REJECTED by policy", async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });

    await api.submit(w, { kind: 'BET', amount: '25.00', externalId: betId }); // different amount
    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved');
    expect(await rowOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'AMOUNT_MISMATCH',
    });
    expect(await eventsOf(refund.body.transactionId)).toContain(
      'WagerTransactionRejected',
    );
  });

  test('deadline expired: REJECTED with REFERENCE_NOT_FOUND, event, and the replay shows the outcome', async () => {
    const w = await newWallet('100.00');
    const op: Operation = {
      kind: 'REFUND',
      amount: '40.00',
      reference: crypto.randomUUID(),
      externalId: crypto.randomUUID(),
    };
    const refund = await early(w, op);

    await Bun.sleep(LOOKUP.ttlMs + 100);
    expect(await resolver.execute(refund.body.transactionId)).toBe('expired');
    expect(await rowOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);

    // the provider resending the same request receives the final outcome
    const replay = await api.submit(w, op);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: true,
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 1 });
  });

  test('chain: ROLLBACK of a REFUND waiting for the BET; both resolve in order', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refundId = crypto.randomUUID();

    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
      externalId: refundId,
    });
    // the REFUND exists, but is still pending: the ROLLBACK waits instead of being rejected
    const rollback = await early(w, {
      kind: 'ROLLBACK',
      amount: '40.00',
      reference: refundId,
    });

    await api.submit(w, { kind: 'BET', amount: '40.00', externalId: betId }); // 100 → 60
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'rescheduled',
    ); // REFUND still pending
    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved'); // 60 → 100, brings forward the ROLLBACK
    expect(
      (await rowOf(rollback.body.transactionId)).next_attempt_at!.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'resolved',
    ); // 100 → 60

    expect(await api.balanceOf(w)).toEqual({ amount: '60.00', version: 4 });
  });

  test('simultaneous resolutions of the same pending reference: a single effect', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });
    await api.submit(w, { kind: 'BET', amount: '40.00', externalId: betId });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolver.execute(refund.body.transactionId),
      ),
    );
    expect(outcomes.filter((o) => o === 'resolved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(9);
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
  });

  test('replay of a still-open pending reference stays 202', async () => {
    const w = await newWallet('100.00');
    const op: Operation = {
      kind: 'REFUND',
      amount: '10.00',
      reference: crypto.randomUUID(),
      externalId: crypto.randomUUID(),
    };
    const first = await early(w, op);
    const replay = await api.submit(w, op);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });
});

describe('reservation of expired pending references', () => {
  test('simultaneous reservations grab disjoint sets, and the reserved ones leave the queue until the reservation expires', async () => {
    // clears pending references from previous tests
    await queryOnce(
      t.db.appUrl,
      `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE status = 'PENDING_REFERENCE'`,
    );

    const w = await newWallet('100.00');
    const pending = await Promise.all(
      Array.from({ length: 12 }, () =>
        early(w, {
          kind: 'REFUND',
          amount: '1.00',
          reference: crypto.randomUUID(),
        }),
      ),
    );
    await Bun.sleep(LOOKUP.backoffBaseMs + 50); // all expired

    const now = new Date();
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        tm.runInTransaction(() =>
          transactions.claimDuePendingReferences({
            now,
            leaseMs: 60_000,
            limit: 5,
          }),
        ),
      ),
    );

    const claimed = claims.flat();
    expect(new Set(claimed).size).toBe(claimed.length); // no pending reference in two reservations
    expect(new Set(claimed)).toEqual(
      new Set(pending.map((p) => p.body.transactionId)),
    );

    // reserved: invisible until the reservation expires
    expect(
      await tm.runInTransaction(() =>
        transactions.claimDuePendingReferences({
          now,
          leaseMs: 60_000,
          limit: 50,
        }),
      ),
    ).toEqual([]);
  });
});
