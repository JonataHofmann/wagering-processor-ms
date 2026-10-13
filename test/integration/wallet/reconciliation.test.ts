import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { METRICS, type Metrics } from '../../../src/platform/observability/metrics';
import { ReconcileWalletsUseCase } from '../../../src/modules/wallet/application/reconcile-wallets.use-case';
import { queryOnce } from '../../support/pg';
import { startTestApp, type TestApp } from '../../support/http-app';
import { type Json, type TestWallet, walletClient } from '../../support/wagering-client';

let t: TestApp;
let api: ReturnType<typeof walletClient>;
let metrics: Metrics;

beforeAll(async () => {
  t = await startTestApp();
  api = walletClient(t.request);
  metrics = t.app.get<Metrics>(METRICS);
});
afterAll(async () => { await t?.close(); });

async function reconcile(walletId: string): Promise<{ status: number; body: Json }> {
  const response = await t.request(`/wallets/${walletId}/reconciliation`, { method: 'POST' });
  return { status: response.status, body: (await response.json()) as Json };
}

/** Wallet com algum histórico: abertura 100, BET 30, WIN 50, BET 20 → 100. */
async function walletWithHistory(): Promise<TestWallet> {
  const { wallet } = await api.openWallet('100.00');
  await api.submit(wallet, { kind: 'BET', amount: '30.00' });
  await api.submit(wallet, { kind: 'WIN', amount: '50.00' });
  await api.submit(wallet, { kind: 'BET', amount: '20.00' });
  return wallet;
}

/**
 * Simula uma corrupção feita por fora da aplicação (ex.: um UPDATE manual em produção).
 * Só o owner consegue, e só desligando os triggers que existem justamente para impedir isso.
 */
async function corrupt(table: 'wallets' | 'wallet_ledger_entries', sql: string, params: unknown[]): Promise<void> {
  await queryOnce(t.db.ownerUrl, `ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await queryOnce(t.db.ownerUrl, sql, params);
  } finally {
    await queryOnce(t.db.ownerUrl, `ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test('wallet saudável: consistente, sem divergências, saldos iguais', async () => {
    const w = await walletWithHistory();
    const { status, body } = await reconcile(w.walletId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      walletId: w.walletId,
      consistent: true,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      ledgerBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      walletVersion: 4,
      ledgerEntries: 4,
      lastLedgerVersion: 4,
      discrepancies: [],
    });
  });

  test('wallet aberta com saldo zero e nunca movimentada: consistente', async () => {
    const { wallet } = await api.openWallet('0.00');
    const { body } = await reconcile(wallet.walletId);
    expect(body).toMatchObject({ consistent: true, ledgerEntries: 0, walletVersion: 1, ledgerBalance: { amount: '0.00' } });
  });

  test('saldo alterado por fora: BALANCE_MISMATCH, log e métrica, e o saldo NÃO é corrigido', async () => {
    const w = await walletWithHistory();
    await corrupt('wallets', `UPDATE wallets SET balance = balance + 5 WHERE id = $1`, [w.walletId]);
    const divergencesBefore = metrics.value('wallet_reconciliation_divergences_total', { code: 'BALANCE_MISMATCH' });

    const { status, body } = await reconcile(w.walletId);

    expect(status).toBe(200); // divergência é um achado, não um erro da requisição
    expect(body.consistent).toBe(false);
    expect(body.difference).toEqual({ amount: '5.00', currency: 'BRL' });
    expect(body.discrepancies.map((d: Json) => d.code).sort()).toEqual(['BALANCE_MISMATCH', 'LAST_ENTRY_MISMATCH']);
    expect(metrics.value('wallet_reconciliation_divergences_total', { code: 'BALANCE_MISMATCH' })).toBe(divergencesBefore + 1);

    // nunca altera saldo silenciosamente: continua o valor corrompido, para investigação
    expect((await api.balanceOf(w)).amount).toBe('105.00');
    expect((await reconcile(w.walletId)).body.consistent).toBe(false);
  });

  test('lançamento apagado do meio do ledger: soma, corrente e sequência quebradas', async () => {
    const w = await walletWithHistory();
    await corrupt('wallet_ledger_entries',
      `DELETE FROM wallet_ledger_entries WHERE wallet_id = $1 AND wallet_version = 2`, [w.walletId]);

    const { body } = await reconcile(w.walletId);
    expect(body.consistent).toBe(false);
    expect(body.ledgerBalance.amount).toBe('130.00'); // o débito de 30 sumiu da soma
    expect(body.discrepancies.map((d: Json) => d.code).sort())
      .toEqual(['BALANCE_MISMATCH', 'LEDGER_CHAIN_BROKEN', 'LEDGER_VERSION_GAP']);
  });

  test('versão da wallet adiantada em relação ao ledger: VERSION_MISMATCH', async () => {
    const w = await walletWithHistory();
    await corrupt('wallets', `UPDATE wallets SET version = version + 1 WHERE id = $1`, [w.walletId]);
    const { body } = await reconcile(w.walletId);
    expect(body.discrepancies.map((d: Json) => d.code)).toEqual(['VERSION_MISMATCH']);
  });

  test('404 para wallet inexistente; 400 para id fora do formato', async () => {
    expect((await reconcile(crypto.randomUUID())).status).toBe(404);
    expect((await reconcile('abc')).status).toBe(400);
  });
});

describe('reconciliação de todas as wallets', () => {
  test('varre em páginas e devolve só as divergentes; registra o resumo em métrica', async () => {
    const healthy = await Promise.all(Array.from({ length: 7 }, () => walletWithHistory()));
    const broken = await walletWithHistory();
    await corrupt('wallets', `UPDATE wallets SET balance = balance - 1 WHERE id = $1`, [broken.walletId]);

    const result = await t.app.get(ReconcileWalletsUseCase).reconcileAll(3); // páginas pequenas: força várias

    const divergentIds = result.divergent.map((r) => r.walletId);
    expect(divergentIds).toContain(broken.walletId);
    for (const w of healthy) expect(divergentIds).not.toContain(w.walletId);

    const [total] = await queryOnce<{ n: string }>(t.db.appUrl, `SELECT count(*) AS n FROM wallets`);
    expect(result.checked).toBe(Number(total!.n)); // nenhuma wallet pulada entre as páginas
    expect(metrics.value('wallet_reconciliation_last_run_wallets')).toBe(result.checked);
    expect(metrics.value('wallet_reconciliation_last_run_divergent_wallets')).toBe(result.divergent.length);
  });
});

describe('reconciliação sob carga', () => {
  test('apostas concorrentes nunca produzem falsa divergência (um único snapshot por consulta)', async () => {
    const { wallet } = await api.openWallet('1000.00');
    let falsePositives = 0;
    let running = true;

    const reconciling = (async () => {
      while (running) {
        const { body } = await reconcile(wallet.walletId);
        if (!body.consistent) falsePositives += 1;
      }
    })();

    await Promise.all(Array.from({ length: 60 }, (_, i) =>
      api.submit(wallet, { kind: i % 3 === 0 ? 'WIN' : 'BET', amount: '5.00' })));
    running = false;
    await reconciling;

    expect(falsePositives).toBe(0);
    expect((await reconcile(wallet.walletId)).body.consistent).toBe(true);
  });
});
