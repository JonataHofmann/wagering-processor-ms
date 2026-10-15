import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReconcileWalletsUseCase } from '../../../src/modules/wallet/application/use-cases/reconcile-wallets.use-case';
import {
  METRICS,
  type Metrics,
} from '../../../src/platform/observability/metrics';
import { startTestApp, type TestApp } from '../../support/http-app';
import { queryOnce } from '../../support/pg';
import {
  type Json,
  type TestWallet,
  walletClient,
} from '../../support/wagering-client';

let t: TestApp;
let api: ReturnType<typeof walletClient>;
let metrics: Metrics;

beforeAll(async () => {
  t = await startTestApp();
  api = walletClient(t.request);
  metrics = t.app.get<Metrics>(METRICS);
});
afterAll(async () => {
  await t?.close();
});

async function reconcile(
  walletId: string,
): Promise<{ status: number; body: Json }> {
  const response = await t.request(`/wallets/${walletId}/reconciliation`, {
    method: 'POST',
  });
  return { status: response.status, body: (await response.json()) as Json };
}

/** Wallet with some history: opening 100, BET 30, WIN 50, BET 20 → 100. */
async function walletWithHistory(): Promise<TestWallet> {
  const { wallet } = await api.openWallet('100.00');
  await api.submit(wallet, { kind: 'BET', amount: '30.00' });
  await api.submit(wallet, { kind: 'WIN', amount: '50.00' });
  await api.submit(wallet, { kind: 'BET', amount: '20.00' });
  return wallet;
}

/**
 * Simulates corruption done outside the application (e.g., a manual UPDATE in production).
 * Only the owner can do it, and only by disabling the triggers that exist precisely to prevent this.
 */
async function corrupt(
  table: 'wallets' | 'wallet_ledger_entries',
  sql: string,
  params: unknown[],
): Promise<void> {
  await queryOnce(t.db.ownerUrl, `ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await queryOnce(t.db.ownerUrl, sql, params);
  } finally {
    await queryOnce(t.db.ownerUrl, `ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test('healthy wallet: consistent, no divergences, equal balances', async () => {
    const w = await walletWithHistory();
    const { status, body } = await reconcile(w.walletId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      walletId: w.walletId,
      consistent: true,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      walletVersion: 4,
      checkedEntries: 4,
      lastLedgerVersion: 4,
      discrepancies: [],
    });
  });

  test('wallet opened with zero balance and never moved: consistent', async () => {
    const { wallet } = await api.openWallet('0.00');
    const { body } = await reconcile(wallet.walletId);
    expect(body).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      walletVersion: 1,
      calculatedBalance: { amount: '0.00' },
    });
  });

  test('balance altered from outside: BALANCE_MISMATCH, log and metric, and the balance is NOT corrected', async () => {
    const w = await walletWithHistory();
    await corrupt(
      'wallets',
      `UPDATE wallets SET balance = balance + 5 WHERE id = $1`,
      [w.walletId],
    );
    const divergencesBefore = metrics.value(
      'wallet_reconciliation_divergences_total',
      { code: 'BALANCE_MISMATCH' },
    );

    const { status, body } = await reconcile(w.walletId);

    expect(status).toBe(200); // divergence is a finding, not a request error
    expect(body.consistent).toBe(false);
    expect(body.difference).toEqual({ amount: '5.00', currency: 'BRL' });
    expect(body.discrepancies.map((d: Json) => d.code).sort()).toEqual([
      'BALANCE_MISMATCH',
      'LAST_ENTRY_MISMATCH',
    ]);
    expect(
      metrics.value('wallet_reconciliation_divergences_total', {
        code: 'BALANCE_MISMATCH',
      }),
    ).toBe(divergencesBefore + 1);

    // never silently alters the balance: keeps the corrupted value, for investigation
    expect((await api.balanceOf(w)).amount).toBe('105.00');
    expect((await reconcile(w.walletId)).body.consistent).toBe(false);
  });

  test('entry deleted from the middle of the ledger: sum, chain, and sequence broken', async () => {
    const w = await walletWithHistory();
    await corrupt(
      'wallet_ledger_entries',
      `DELETE FROM wallet_ledger_entries WHERE wallet_id = $1 AND wallet_version = 2`,
      [w.walletId],
    );

    const { body } = await reconcile(w.walletId);
    expect(body.consistent).toBe(false);
    expect(body.calculatedBalance.amount).toBe('130.00'); // the debit of 30 disappeared from the sum
    expect(body.discrepancies.map((d: Json) => d.code).sort()).toEqual([
      'BALANCE_MISMATCH',
      'LEDGER_CHAIN_BROKEN',
      'LEDGER_VERSION_GAP',
    ]);
  });

  test('wallet version ahead of the ledger: VERSION_MISMATCH', async () => {
    const w = await walletWithHistory();
    await corrupt(
      'wallets',
      `UPDATE wallets SET version = version + 1 WHERE id = $1`,
      [w.walletId],
    );
    const { body } = await reconcile(w.walletId);
    expect(body.discrepancies.map((d: Json) => d.code)).toEqual([
      'VERSION_MISMATCH',
    ]);
  });

  test('404 for a nonexistent wallet; 400 for an id not in the format', async () => {
    expect((await reconcile(crypto.randomUUID())).status).toBe(404);
    expect((await reconcile('abc')).status).toBe(400);
  });
});

describe('reconciliation of all wallets', () => {
  test('scans in pages and returns only the divergent ones; records the summary in a metric', async () => {
    const healthy = await Promise.all(
      Array.from({ length: 7 }, () => walletWithHistory()),
    );
    const broken = await walletWithHistory();
    await corrupt(
      'wallets',
      `UPDATE wallets SET balance = balance - 1 WHERE id = $1`,
      [broken.walletId],
    );

    const result = await t.app.get(ReconcileWalletsUseCase).reconcileAll(3); // small pages: forces several

    const divergentIds = result.divergent.map((r) => r.walletId);
    expect(divergentIds).toContain(broken.walletId);
    for (const w of healthy) expect(divergentIds).not.toContain(w.walletId);

    const [total] = await queryOnce<{ n: string }>(
      t.db.appUrl,
      `SELECT count(*) AS n FROM wallets`,
    );
    expect(result.checked).toBe(Number(total!.n)); // no wallet skipped between pages
    expect(metrics.value('wallet_reconciliation_last_run_wallets')).toBe(
      result.checked,
    );
    expect(
      metrics.value('wallet_reconciliation_last_run_divergent_wallets'),
    ).toBe(result.divergent.length);
  });
});

describe('reconciliation under load', () => {
  test('concurrent bets never produce a false divergence (a single snapshot per query)', async () => {
    const { wallet } = await api.openWallet('1000.00');
    let falsePositives = 0;
    let running = true;

    const reconciling = (async () => {
      while (running) {
        const { body } = await reconcile(wallet.walletId);
        if (!body.consistent) falsePositives += 1;
      }
    })();

    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        api.submit(wallet, {
          kind: i % 3 === 0 ? 'WIN' : 'BET',
          amount: '5.00',
        }),
      ),
    );
    running = false;
    await reconciling;

    expect(falsePositives).toBe(0);
    expect((await reconcile(wallet.walletId)).body.consistent).toBe(true);
  });
});
