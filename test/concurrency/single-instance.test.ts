import { Money } from '@/src/shared/domain/money';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import {
  connectPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import {
  type Operation,
  type SubmitResult,
  type TestWallet,
  walletClient,
} from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/** How many times each race is repeated. Increase locally: CONCURRENCY_ITERATIONS=100 */
const ITERATIONS = Number(process.env.CONCURRENCY_ITERATIONS ?? 10);

let t: TestApp;
let p: Persistence;
let api: ReturnType<typeof walletClient>;

beforeAll(async () => {
  t = await startTestApp();
  p = await connectPersistence(t.db);
  api = walletClient(t.request);
});

afterAll(async () => {
  // final invariant: no wallet in the database diverges from its own ledger
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await p?.close();
  await t?.close();
});

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

/** Fires all operations at the same time. */
function race(w: TestWallet, operations: Operation[]): Promise<SubmitResult[]> {
  return Promise.all(operations.map((op) => api.submit(w, op)));
}

function times<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

async function countEntries(
  w: TestWallet,
  direction?: 'DEBIT' | 'CREDIT',
): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    t.db.appUrl,
    `SELECT count(*) AS n FROM wallet_ledger_entries
      WHERE wallet_id = $1 AND ($2::text IS NULL OR direction = $2)`,
    [w.walletId, direction ?? null],
  );
  return Number(row!.n);
}

// ===================================================================== same wallet

describe('dispute over the balance of the same wallet', () => {
  test(`prompt scenario (100.00, two bets of 80.00), repeated ${ITERATIONS} times`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const w = await newWallet('100.00');
      const results = await race(w, [
        { kind: 'BET', amount: '80.00' },
        { kind: 'BET', amount: '80.00' },
      ]);

      expect(results.map((r) => r.body.status).sort()).toEqual([
        'PROCESSED',
        'REJECTED',
      ]);
      expect(
        results.find((r) => r.body.status === 'REJECTED')!.body.failureCode,
      ).toBe('INSUFFICIENT_FUNDS');
      expect(await api.balanceOf(w)).toEqual({ amount: '20.00', version: 2 });
      expect(await countEntries(w, 'DEBIT')).toBe(1);
    }
  });

  test('30 bets of 10.00 against 100.00: exactly 10 go through and the balance hits zero, never negative', async () => {
    const w = await newWallet('100.00');
    const results = await race(
      w,
      times(30, () => ({ kind: 'BET', amount: '10.00' })),
    );

    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(
      10,
    );
    expect(
      results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(20);
    expect(await api.balanceOf(w)).toEqual({ amount: '0.00', version: 11 });
    expect(await countEntries(w, 'DEBIT')).toBe(10);

    // the observed balance for each accepted bet is unique: decisions were serialized
    const observed = results
      .filter((r) => r.body.status === 'PROCESSED')
      .map((r) => r.body.balance.amount)
      .sort();
    expect(observed).toEqual([
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
  });

  test('simultaneous mixed operations: the final balance is exactly that of the accepted operations', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const w = await newWallet('50.00');
      const operations: Operation[] = [
        ...times(10, () => ({ kind: 'BET', amount: '7.00' })),
        ...times(5, () => ({ kind: 'WIN', amount: '3.50' })),
        ...times(5, () => ({ kind: 'LOSS', amount: '1.00' })),
      ];
      const results = await race(w, operations);

      // expected balance, computed only from what the API said it accepted
      let expected = Money.from({ amount: '50.00', currency: 'BRL' });
      results.forEach((result, index) => {
        if (result.body.status !== 'PROCESSED') return;
        const op = operations[index]!;
        const money = Money.from({ amount: op.amount, currency: 'BRL' });
        if (op.kind === 'BET') expected = expected.subtract(money);
        if (op.kind === 'WIN') expected = expected.add(money);
      });

      expect((await api.balanceOf(w)).amount).toBe(expected.amount);
      expect(
        results.every(
          (r) =>
            r.status === 200 || r.body.failureCode === 'INSUFFICIENT_FUNDS',
        ),
      ).toBe(true);
      expect(
        results.filter(
          (r) => r.body.status === 'PROCESSED' && r.body.balance === null,
        ),
      ).toHaveLength(0);
    }
  });
});

// ===================================================================== idempotency under race

describe('idempotency under race', () => {
  test(`the same bet 50 times in parallel generates a single debit, repeated ${Math.ceil(ITERATIONS / 2)} times`, async () => {
    for (let i = 0; i < Math.ceil(ITERATIONS / 2); i++) {
      const w = await newWallet('100.00');
      const op: Operation = {
        kind: 'BET',
        amount: '10.00',
        externalId: crypto.randomUUID(),
      };
      const results = await race(
        w,
        times(50, () => op),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        results.filter((r) => r.body.idempotentReplay === false),
      ).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
      expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(
        new Set(['90.00']),
      );
      expect(await countEntries(w, 'DEBIT')).toBe(1);
    }
  });

  test('the same key on different wallets at the same time: one processes, the others conflict', async () => {
    const wallets = await Promise.all(times(5, () => newWallet('100.00')));
    const externalId = crypto.randomUUID();
    const results = await Promise.all(
      wallets.map((w) =>
        api.submit(w, { kind: 'BET', amount: '10.00', externalId }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).map((r) => r.body.error.code),
    ).toEqual(times(4, () => 'IDEMPOTENCY_KEY_REUSED'));

    const [row] = await queryOnce<{ n: string }>(
      t.db.appUrl,
      `SELECT count(*) AS n FROM wager_transactions WHERE external_transaction_id = $1`,
      [externalId],
    );
    expect(row!.n).toBe('1');
  });

  test('simultaneous REFUNDs of the same BET (different ids): only one refunds the amount', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const w = await newWallet('100.00');
      const bet = await api.submit(w, { kind: 'BET', amount: '40.00' });
      const results = await race(
        w,
        times(5, () => ({
          kind: 'REFUND',
          amount: '40.00',
          reference: bet.externalId,
        })),
      );

      expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(
        1,
      );
      expect(
        results.filter(
          (r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED',
        ),
      ).toHaveLength(4);
      expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
    }
  });

  test('simultaneous creation of the same wallet: one 201, the others 409', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(
      times(10, () => api.openWallet('10.00', { playerId })),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });
});

// ===================================================================== different wallets

describe('different wallets in parallel', () => {
  test('20 wallets with 5 bets each, all at the same time: each one settles correctly', async () => {
    const wallets = await Promise.all(times(20, () => newWallet('100.00')));
    await Promise.all(
      wallets.flatMap((w) =>
        times(5, () => api.submit(w, { kind: 'BET', amount: '15.00' })),
      ),
    );

    for (const w of wallets) {
      expect(await api.balanceOf(w)).toEqual({ amount: '25.00', version: 6 });
    }
  });

  test('the lock is per wallet: with wallet A locked, wallet B responds right away and A waits', async () => {
    const a = await newWallet('100.00');
    const b = await newWallet('100.00');

    // holds wallet A's lock from outside the application, as if another transaction were in progress
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = p.tm.runInTransaction(async () => {
      await p.wallets.findByIdForUpdate(a.walletId);
      locked();
      await held;
    });
    await lockTaken;

    const startB = performance.now();
    const onB = await api.submit(b, { kind: 'BET', amount: '10.00' });
    const elapsedB = performance.now() - startB;

    const pendingOnA = api.submit(a, { kind: 'BET', amount: '10.00' });
    await Bun.sleep(300);
    release();
    await holder;
    const onA = await pendingOnA;

    expect(onB.status).toBe(200);
    expect(elapsedB).toBeLessThan(1_000); // B didn't wait for A's lock (which is still held)
    expect(onA.status).toBe(200); // A waited and processed as soon as the lock was released
  });

  test('waiting for the lock past lock_timeout becomes a 503 with Retry-After, no side effect', async () => {
    const w = await newWallet('100.00');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = p.tm.runInTransaction(async () => {
      await p.wallets.findByIdForUpdate(w.walletId);
      locked();
      await held; // holds the lock past the application's 2s lock_timeout
    });
    await lockTaken;

    const op: Operation = {
      kind: 'BET',
      amount: '10.00',
      externalId: crypto.randomUUID(),
    };
    const { key, body } = api.payload(w, op);
    const response = await t.request('/wagering/transactions', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': key },
    });
    release();
    await holder;

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 1 });

    // resending the same request afterwards works: nothing from the previous attempt was persisted
    const retry = await api.submit(w, op);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
  });
});
