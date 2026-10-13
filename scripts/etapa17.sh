#!/usr/bin/env bash
# =============================================================================
# Etapa 17: Reconciliação
#
# Aplica, na raiz do repositório wagering-processor-ms:
#   - 9 arquivos novos (código, comando e testes);
#   - 5 edições em arquivos existentes (app.module, persistence.module,
#     wallet.module, wallets.controller, package.json).
#
# Seguro para rodar mais de uma vez: arquivos novos já existentes são guardados
# em .etapa17-backup/ antes de serem sobrescritos, e edições já aplicadas são puladas.
# Se uma edição não encontrar o trecho esperado, ela NÃO é adivinhada: o script
# avisa exatamente o que fazer à mão e sai com erro.
#
# Uso:
#   bash apply-etapa17.sh             # aplica e roda typecheck + testes da etapa
#   bash apply-etapa17.sh --no-tests  # só aplica e roda o typecheck
# =============================================================================
set -euo pipefail

RUN_TESTS=1
[ "${1:-}" = "--no-tests" ] && RUN_TESTS=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- pré-condições
[ -f package.json ] && [ -f src/app.module.ts ] || fail "rode na raiz do repositório (onde estão package.json e src/app.module.ts)"
command -v bun >/dev/null || fail "bun não encontrado no PATH"
for f in src/platform/testing/fault-injection.ts src/modules/wagering/infrastructure/scheduler/scheduler.config.ts; do
  [ -f "$f" ] || fail "não encontrei $f: aplique as etapas 14 a 16 antes da 17"
done
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "Aviso: há alterações não commitadas. Recomendo commitar antes, para poder revisar o diff desta etapa."
  printf "Continuar mesmo assim? [s/N] "; read -r answer
  case "$answer" in s|S|y|Y) ;; *) exit 1 ;; esac
fi

BACKUP=".etapa17-backup/$(date +%Y%m%d-%H%M%S)"

# Escreve um arquivo novo; se já existir com conteúdo diferente, guarda uma cópia antes.
write_file() {
  local path="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  mkdir -p "$(dirname "$path")"
  if [ -f "$path" ] && ! cmp -s "$tmp" "$path"; then
    mkdir -p "$BACKUP/$(dirname "$path")"
    cp "$path" "$BACKUP/$path"
    echo "  · $path (já existia: cópia em $BACKUP/$path)"
  elif [ -f "$path" ]; then
    echo "  · $path (já estava igual)"
    rm -f "$tmp"; return
  else
    echo "  ✓ $path"
  fi
  mv "$tmp" "$path"
}

say "1/4 Arquivos novos"
write_file src/platform/observability/metrics.ts <<'ETAPA17_EOF'
/**
 * Registro de métricas mínimo, em memória. A etapa 19 expõe estes valores no
 * formato Prometheus (GET /metrics); até lá, eles já são contados e testáveis.
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  /** contador: só cresce */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** gauge: valor atual */
  set(name: string, value: number, labels?: MetricLabels): void;
  /** valor atual de uma série (0 se nunca registrada) */
  value(name: string, labels?: MetricLabels): number;
  /** todas as séries, para exposição */
  snapshot(): ReadonlyArray<{ name: string; labels: MetricLabels; value: number }>;
}

export const METRICS = Symbol('Metrics');

function seriesKey(name: string, labels: MetricLabels): string {
  const sorted = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`);
  return `${name}{${sorted.join(',')}}`;
}

export class InMemoryMetrics implements Metrics {
  private readonly series = new Map<string, { name: string; labels: MetricLabels; value: number }>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const current = this.series.get(seriesKey(name, labels));
    this.series.set(seriesKey(name, labels), { name, labels, value: (current?.value ?? 0) + by });
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    this.series.set(seriesKey(name, labels), { name, labels, value });
  }

  value(name: string, labels: MetricLabels = {}): number {
    return this.series.get(seriesKey(name, labels))?.value ?? 0;
  }

  snapshot() {
    return [...this.series.values()];
  }
}
ETAPA17_EOF

write_file src/modules/wallet/application/ports/reconciliation.repository.ts <<'ETAPA17_EOF'
/**
 * Foto de uma wallet e do seu ledger, lida num ÚNICO comando SQL (um único snapshot):
 * uma movimentação concorrente nunca aparece "pela metade" e não gera falsa divergência.
 */
export interface WalletLedgerSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  walletVersion: number;
  /** soma assinada de todos os lançamentos (CREDIT +, DEBIT -) */
  ledgerBalance: string;
  /** storedBalance - ledgerBalance */
  difference: string;
  ledgerEntries: number;
  lastLedgerVersion: number | null;
  lastBalanceAfter: string | null;
  /** lançamentos cujo balance_before não é o balance_after do anterior */
  chainBreaks: number;
  /** saltos na sequência de wallet_version */
  versionGaps: number;
}

export interface ReconciliationRepository {
  snapshotOf(walletId: string): Promise<WalletLedgerSnapshot | undefined>;
  /** Página de wallets em ordem de id (keyset), para varrer todas. */
  snapshotPage(request: { afterWalletId?: string; limit: number }): Promise<WalletLedgerSnapshot[]>;
}

export const RECONCILIATION_REPOSITORY = Symbol('ReconciliationRepository');
ETAPA17_EOF

write_file src/modules/wallet/application/ports/reconciliation-alerts.port.ts <<'ETAPA17_EOF'
import type { WalletReconciliation } from '../reconcile-wallets.use-case';

/** Para onde vai o resultado de cada verificação (logs e métricas). */
export interface ReconciliationAlerts {
  walletChecked(report: WalletReconciliation): void;
  fullRunCompleted(summary: { checked: number; divergent: number }): void;
}

export const RECONCILIATION_ALERTS = Symbol('ReconciliationAlerts');
ETAPA17_EOF

write_file src/modules/wallet/application/reconcile-wallets.use-case.ts <<'ETAPA17_EOF'
import { ResourceNotFoundError } from '../../../shared/application/application-errors';
import type { Clock } from '../../../shared/application/ports/clock.port';
import type { TransactionManager } from '../../../shared/application/ports/transaction-manager.port';
import type { MoneyProps } from '../../../shared/domain/money';
import type { ReconciliationAlerts } from './ports/reconciliation-alerts.port';
import type { ReconciliationRepository, WalletLedgerSnapshot } from './ports/reconciliation.repository';

export type DiscrepancyCode =
  | 'BALANCE_MISMATCH'      // saldo gravado ≠ soma do ledger (a verificação exigida pelo enunciado)
  | 'LAST_ENTRY_MISMATCH'   // saldo gravado ≠ balance_after do último lançamento
  | 'VERSION_MISMATCH'      // versão da wallet ≠ versão do último lançamento
  | 'LEDGER_CHAIN_BROKEN'   // um lançamento não começa onde o anterior terminou
  | 'LEDGER_VERSION_GAP';   // falta um lançamento na sequência de versões

export interface Discrepancy {
  code: DiscrepancyCode;
  detail: string;
}

export interface WalletReconciliation {
  walletId: string;
  consistent: boolean;
  storedBalance: MoneyProps;
  ledgerBalance: MoneyProps;
  difference: MoneyProps;
  walletVersion: number;
  ledgerEntries: number;
  lastLedgerVersion: number | null;
  discrepancies: Discrepancy[];
  checkedAt: string;
}

export interface FullReconciliation {
  checked: number;
  divergent: WalletReconciliation[];
}


/**
 * Avalia a foto: lista todas as divergências encontradas (vazia = consistente).
 * Os valores chegam do SQL já normalizados com duas casas como texto ("100.00"),
 * então a comparação de strings é exata.
 */
export function findDiscrepancies(s: WalletLedgerSnapshot): Discrepancy[] {
  const found: Discrepancy[] = [];

  if (s.storedBalance !== s.ledgerBalance) {
    found.push({ code: 'BALANCE_MISMATCH', detail: `stored ${s.storedBalance} vs ledger ${s.ledgerBalance} (difference ${s.difference})` });
  }

  if (s.ledgerEntries === 0) {
    // wallet aberta com saldo zero e nunca movimentada: versão 1, saldo 0
    if (s.walletVersion !== 1) found.push({ code: 'VERSION_MISMATCH', detail: `version ${s.walletVersion} without ledger entries` });
  } else {
    if (s.lastBalanceAfter !== null && s.storedBalance !== s.lastBalanceAfter) {
      found.push({ code: 'LAST_ENTRY_MISMATCH', detail: `stored ${s.storedBalance} vs last entry ${s.lastBalanceAfter}` });
    }
    if (s.lastLedgerVersion !== s.walletVersion) {
      found.push({ code: 'VERSION_MISMATCH', detail: `wallet version ${s.walletVersion} vs last entry version ${s.lastLedgerVersion}` });
    }
  }
  if (s.chainBreaks > 0) found.push({ code: 'LEDGER_CHAIN_BROKEN', detail: `${s.chainBreaks} entries do not start where the previous ended` });
  if (s.versionGaps > 0) found.push({ code: 'LEDGER_VERSION_GAP', detail: `${s.versionGaps} gaps in the wallet_version sequence` });

  return found;
}

/**
 * Compara o saldo gravado com o saldo reconstruído pelo ledger.
 * SOMENTE LEITURA: nunca corrige saldo. Uma divergência é um incidente para investigar,
 * registrado em log e métrica; corrigir "automaticamente" esconderia a causa.
 */
export class ReconcileWalletsUseCase {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly repository: ReconciliationRepository,
    private readonly alerts: ReconciliationAlerts,
    private readonly clock: Clock,
  ) {}

  async reconcile(walletId: string): Promise<WalletReconciliation> {
    const snapshot = await this.transactionManager.runInTransaction(() => this.repository.snapshotOf(walletId));
    if (snapshot === undefined) throw new ResourceNotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
    const report = this.toReport(snapshot);
    this.alerts.walletChecked(report);
    return report;
  }

  /** Varre todas as wallets em páginas; devolve só as divergentes. */
  async reconcileAll(pageSize = 500): Promise<FullReconciliation> {
    let checked = 0;
    const divergent: WalletReconciliation[] = [];
    let afterWalletId: string | undefined;

    for (;;) {
      const page = await this.transactionManager.runInTransaction(() =>
        this.repository.snapshotPage({ afterWalletId, limit: pageSize }));
      for (const snapshot of page) {
        const report = this.toReport(snapshot);
        this.alerts.walletChecked(report);
        checked += 1;
        if (!report.consistent) divergent.push(report);
      }
      if (page.length < pageSize) break;
      afterWalletId = page[page.length - 1]!.walletId;
    }

    this.alerts.fullRunCompleted({ checked, divergent: divergent.length });
    return { checked, divergent };
  }

  private toReport(s: WalletLedgerSnapshot): WalletReconciliation {
    const discrepancies = findDiscrepancies(s);
    const money = (amount: string): MoneyProps => ({ amount, currency: s.currency });
    return {
      walletId: s.walletId,
      consistent: discrepancies.length === 0,
      storedBalance: money(s.storedBalance),
      ledgerBalance: money(s.ledgerBalance),
      difference: money(s.difference),
      walletVersion: s.walletVersion,
      ledgerEntries: s.ledgerEntries,
      lastLedgerVersion: s.lastLedgerVersion,
      discrepancies,
      checkedAt: this.clock.now().toISOString(),
    };
  }
}
ETAPA17_EOF

write_file src/modules/wallet/infrastructure/reconciliation/mikro-reconciliation.repository.ts <<'ETAPA17_EOF'
import type { EntityManagerContext } from '../../../../infrastructure/persistence/entity-manager-context';
import type { ReconciliationRepository, WalletLedgerSnapshot } from '../../application/ports/reconciliation.repository';

interface SnapshotRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  wallet_version: number;
  ledger_balance: string;
  difference: string;
  ledger_entries: string;
  last_ledger_version: number | null;
  last_balance_after: string | null;
  chain_breaks: string;
  version_gaps: string;
}

/**
 * Um único comando SQL por consulta: no READ COMMITTED, cada comando enxerga um snapshot
 * consistente do banco. Uma aposta concorrente aparece inteira (wallet + lançamento) ou não aparece.
 * Todos os valores saem como round(x, 2)::text: "100.00", nunca "100".
 */
const SNAPSHOT_SQL = (targetFilter: string) => `
  WITH target AS (
    SELECT id, currency, balance, version FROM wallets ${targetFilter}
  ),
  entries AS (
    SELECT e.wallet_id, e.wallet_version, e.direction, e.amount, e.balance_before, e.balance_after,
           LAG(e.balance_after)  OVER w AS previous_after,
           LAG(e.wallet_version) OVER w AS previous_version
      FROM wallet_ledger_entries e
      JOIN target t ON t.id = e.wallet_id
    WINDOW w AS (PARTITION BY e.wallet_id ORDER BY e.wallet_version)
  ),
  totals AS (
    SELECT wallet_id,
           SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS replayed,
           COUNT(*) AS entries,
           MAX(wallet_version) AS last_version,
           COUNT(*) FILTER (WHERE previous_after IS NOT NULL AND previous_after <> balance_before) AS chain_breaks,
           COUNT(*) FILTER (WHERE previous_version IS NOT NULL AND wallet_version <> previous_version + 1) AS version_gaps
      FROM entries GROUP BY wallet_id
  ),
  last_entry AS (
    SELECT DISTINCT ON (wallet_id) wallet_id, balance_after
      FROM entries ORDER BY wallet_id, wallet_version DESC
  )
  SELECT t.id AS wallet_id,
         t.currency,
         round(t.balance, 2)::text AS stored_balance,
         t.version AS wallet_version,
         round(COALESCE(tt.replayed, 0), 2)::text AS ledger_balance,
         round(t.balance - COALESCE(tt.replayed, 0), 2)::text AS difference,
         COALESCE(tt.entries, 0) AS ledger_entries,
         tt.last_version AS last_ledger_version,
         round(l.balance_after, 2)::text AS last_balance_after,
         COALESCE(tt.chain_breaks, 0) AS chain_breaks,
         COALESCE(tt.version_gaps, 0) AS version_gaps
    FROM target t
    LEFT JOIN totals tt ON tt.wallet_id = t.id
    LEFT JOIN last_entry l ON l.wallet_id = t.id
   ORDER BY t.id`;

function toSnapshot(row: SnapshotRow): WalletLedgerSnapshot {
  return {
    walletId: row.wallet_id,
    currency: row.currency,
    storedBalance: row.stored_balance,
    walletVersion: Number(row.wallet_version),
    ledgerBalance: row.ledger_balance,
    difference: row.difference,
    ledgerEntries: Number(row.ledger_entries),
    lastLedgerVersion: row.last_ledger_version === null ? null : Number(row.last_ledger_version),
    lastBalanceAfter: row.last_balance_after,
    chainBreaks: Number(row.chain_breaks),
    versionGaps: Number(row.version_gaps),
  };
}

export class MikroReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async snapshotOf(walletId: string): Promise<WalletLedgerSnapshot | undefined> {
    const rows = await this.context.current().execute<SnapshotRow[]>(SNAPSHOT_SQL('WHERE id = ?'), [walletId]);
    return rows[0] ? toSnapshot(rows[0]) : undefined;
  }

  async snapshotPage({ afterWalletId, limit }: { afterWalletId?: string; limit: number }): Promise<WalletLedgerSnapshot[]> {
    const rows = afterWalletId === undefined
      ? await this.context.current().execute<SnapshotRow[]>(SNAPSHOT_SQL('ORDER BY id LIMIT ?'), [limit])
      : await this.context.current().execute<SnapshotRow[]>(SNAPSHOT_SQL('WHERE id > ? ORDER BY id LIMIT ?'), [afterWalletId, limit]);
    return rows.map(toSnapshot);
  }
}
ETAPA17_EOF

write_file src/modules/wallet/infrastructure/reconciliation/logging-reconciliation-alerts.ts <<'ETAPA17_EOF'
import { Logger } from '@nestjs/common';
import type { Metrics } from '../../../../platform/observability/metrics';
import type { ReconciliationAlerts } from '../../application/ports/reconciliation-alerts.port';
import type { WalletReconciliation } from '../../application/reconcile-wallets.use-case';

/**
 * Toda verificação vira métrica; toda divergência vira log de erro estruturado
 * (um alerta deve disparar em cima de wallet_reconciliation_divergences_total > 0).
 */
export class LoggingReconciliationAlerts implements ReconciliationAlerts {
  private readonly logger = new Logger('Reconciliation');

  constructor(private readonly metrics: Metrics) {}

  walletChecked(report: WalletReconciliation): void {
    this.metrics.increment('wallet_reconciliation_checks_total', { result: report.consistent ? 'consistent' : 'divergent' });
    if (report.consistent) return;

    for (const discrepancy of report.discrepancies) {
      this.metrics.increment('wallet_reconciliation_divergences_total', { code: discrepancy.code });
    }
    this.logger.error(JSON.stringify({
      event: 'WALLET_LEDGER_DIVERGENCE',
      walletId: report.walletId,
      storedBalance: report.storedBalance,
      ledgerBalance: report.ledgerBalance,
      difference: report.difference,
      walletVersion: report.walletVersion,
      lastLedgerVersion: report.lastLedgerVersion,
      discrepancies: report.discrepancies,
    }));
  }

  fullRunCompleted(summary: { checked: number; divergent: number }): void {
    this.metrics.set('wallet_reconciliation_last_run_wallets', summary.checked);
    this.metrics.set('wallet_reconciliation_last_run_divergent_wallets', summary.divergent);
    const message = `full reconciliation: ${summary.checked} wallets checked, ${summary.divergent} divergent`;
    if (summary.divergent > 0) this.logger.error(message);
    else this.logger.log(message);
  }
}
ETAPA17_EOF

write_file scripts/reconcile.ts <<'ETAPA17_EOF'
/**
 * Reconcilia TODAS as wallets: saldo gravado × saldo reconstruído pelo ledger.
 * Somente leitura. Uso: bun run reconcile
 *
 * stdout: uma linha JSON por wallet divergente + uma linha de resumo
 * stderr: logs (divergências também saem como log de erro)
 * exit code: 0 = tudo consistente, 1 = divergência encontrada, 2 = falha ao executar
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import type { AppRole } from '../src/config/app-roles';
import { ReconcileWalletsUseCase } from '../src/modules/wallet/application/reconcile-wallets.use-case';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  // nenhum papel: sem HTTP, sem consumer, sem relay, sem scheduler; só os casos de uso
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ databaseUrl, roles: new Set<AppRole>() }),
    { logger: ['error', 'warn'] },
  );

  try {
    const pageSize = Number(process.env.RECONCILE_PAGE_SIZE ?? 500);
    const result = await app.get(ReconcileWalletsUseCase).reconcileAll(pageSize);
    for (const report of result.divergent) console.log(JSON.stringify(report));
    console.log(JSON.stringify({ checked: result.checked, divergent: result.divergent.length }));
    process.exitCode = result.divergent.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
ETAPA17_EOF

write_file test/integration/wallet/reconciliation.test.ts <<'ETAPA17_EOF'
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
ETAPA17_EOF

write_file test/integration/wallet/reconcile-command.test.ts <<'ETAPA17_EOF'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { queryOnce } from '../../support/pg';
import { startTestApp, type TestApp } from '../../support/http-app';
import { walletClient } from '../../support/wagering-client';

let t: TestApp;

beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t?.close(); });

/** Roda `bun scripts/reconcile.ts` contra o banco do teste, como um operador faria. */
async function runCommand(): Promise<{ exitCode: number; lines: Array<Record<string, any>> }> {
  const child = Bun.spawn([process.execPath, 'scripts/reconcile.ts'], {
    env: { ...process.env, DATABASE_URL: t.db.appUrl, MIKRO_ORM_DEBUG: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const lines = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return { exitCode, lines };
}

describe('bun run reconcile', () => {
  test('tudo consistente: exit 0 e só a linha de resumo', async () => {
    const api = walletClient(t.request);
    const { wallet } = await api.openWallet('50.00');
    await api.submit(wallet, { kind: 'BET', amount: '10.00' });

    const { exitCode, lines } = await runCommand();
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ divergent: 0 });
    expect(lines[0]!.checked).toBeGreaterThan(0);
  });

  test('com divergência: exit 1, uma linha por wallet divergente, e nada é corrigido', async () => {
    const { wallet } = await walletClient(t.request).openWallet('80.00');
    await queryOnce(t.db.ownerUrl, `ALTER TABLE wallets DISABLE TRIGGER USER`);
    await queryOnce(t.db.ownerUrl, `UPDATE wallets SET balance = 81 WHERE id = $1`, [wallet.walletId]);
    await queryOnce(t.db.ownerUrl, `ALTER TABLE wallets ENABLE TRIGGER USER`);

    const { exitCode, lines } = await runCommand();
    expect(exitCode).toBe(1);
    expect(lines.find((l) => l.walletId === wallet.walletId)).toMatchObject({
      consistent: false,
      difference: { amount: '1.00', currency: 'BRL' },
    });
    expect(lines.at(-1)).toMatchObject({ divergent: 1 });

    const [row] = await queryOnce<{ balance: string }>(t.db.appUrl, `SELECT round(balance, 2)::text AS balance FROM wallets WHERE id = $1`, [wallet.walletId]);
    expect(row!.balance).toBe('81.00');
  });
});
ETAPA17_EOF

say "2/4 Edições em arquivos existentes"
WORKDIR="$(mktemp -d)"
PATCHER="$WORKDIR/patch-etapa17.ts"
cat > "$PATCHER" <<'ETAPA17_EOF'
/**
 * Edições da etapa 17 nos arquivos que já existem. Cada edição:
 *  - é pulada se já foi aplicada (o script pode rodar mais de uma vez);
 *  - falha com uma mensagem clara se o trecho esperado não for encontrado (nada é adivinhado).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type Result = { file: string; change: string; status: 'aplicado' | 'já aplicado' | 'FALHOU'; hint?: string };
const results: Result[] = [];

function edit(file: string, change: string, alreadyApplied: (src: string) => boolean, apply: (src: string) => string | undefined, hint: string): void {
  if (!existsSync(file)) {
    results.push({ file, change, status: 'FALHOU', hint: `arquivo não encontrado. ${hint}` });
    return;
  }
  const src = readFileSync(file, 'utf8');
  if (alreadyApplied(src)) {
    results.push({ file, change, status: 'já aplicado' });
    return;
  }
  const out = apply(src);
  if (out === undefined || out === src) {
    results.push({ file, change, status: 'FALHOU', hint });
    return;
  }
  writeFileSync(file, out);
  results.push({ file, change, status: 'aplicado' });
}

/** Insere uma linha de import antes do primeiro comando que não é import. */
function addImport(src: string, line: string): string {
  if (src.includes(line)) return src;
  const match = /^(?:@|export |const |class |function |interface |type |async )/m.exec(src);
  if (!match) return `${line}\n${src}`;
  return `${src.slice(0, match.index)}${line}\n${src.slice(match.index)}`;
}

/** Acrescenta um token ao fim do primeiro array `exports: [...]` do arquivo. */
function appendToExports(src: string, token: string): string | undefined {
  const start = src.indexOf('exports: [');
  if (start === -1) return undefined;
  const close = src.indexOf(']', start);
  if (close === -1) return undefined;
  const inside = src.slice(start + 'exports: ['.length, close);
  if (new RegExp(`\\b${token}\\b`).test(inside)) return src;
  const trimmed = inside.replace(/\s+$/, '');
  const multiline = inside.includes('\n');
  const separator = trimmed === '' ? '' : trimmed.endsWith(',') ? '' : ',';
  const newInside = multiline
    ? `${trimmed}${separator}\n        ${token},\n      `
    : `${trimmed}${separator}${trimmed === '' ? '' : ' '}${token}`;
  return src.slice(0, start + 'exports: ['.length) + newInside + src.slice(close);
}

// ------------------------------------------------------------------ src/app.module.ts

edit(
  'src/app.module.ts',
  'registrar METRICS no AppConfigModule',
  (s) => s.includes('provide: METRICS'),
  (s) => {
    let out = addImport(s, "import { InMemoryMetrics, METRICS } from './platform/observability/metrics';");
    const providerLine = /([ \t]*)\{ provide: SCHEDULER_CONFIG, useValue: scheduler \},\n/;
    const m = providerLine.exec(out);
    if (!m) return undefined;
    out = out.replace(providerLine, `${m[0]}${m[1]}{ provide: METRICS, useValue: new InMemoryMetrics() },\n`);
    const exportsLine = /exports: \[APP_ROLES, REFERENCE_LOOKUP_POLICY, SCHEDULER_CONFIG\]/;
    if (!exportsLine.test(out)) return undefined;
    return out.replace(exportsLine, 'exports: [APP_ROLES, REFERENCE_LOOKUP_POLICY, SCHEDULER_CONFIG, METRICS]');
  },
  "no AppConfigModule.forRoot, acrescente `{ provide: METRICS, useValue: new InMemoryMetrics() }` aos providers e `METRICS` aos exports (passo 1).",
);

// ------------------------------------------------------------------ persistence.module.ts

edit(
  'src/infrastructure/persistence/persistence.module.ts',
  'registrar RECONCILIATION_REPOSITORY',
  (s) => s.includes('provide: RECONCILIATION_REPOSITORY'),
  (s) => {
    let out = addImport(s, "import { RECONCILIATION_REPOSITORY } from '../../modules/wallet/application/ports/reconciliation.repository';");
    out = addImport(out, "import { MikroReconciliationRepository } from '../../modules/wallet/infrastructure/reconciliation/mikro-reconciliation.repository';");
    const provider = [
      '{',
      '          provide: RECONCILIATION_REPOSITORY,',
      '          useFactory: (c: EntityManagerContext) => new MikroReconciliationRepository(c),',
      '          inject: [EntityManagerContext],',
      '        },',
    ].join('\n');
    // depois do provider da outbox (em uma linha), ou antes do OrmShutdown
    const outboxLine = /^([ \t]*)\{ provide: OUTBOX_REPOSITORY,[^\n]*\},[ \t]*\n/m;
    const m = outboxLine.exec(out);
    if (m) {
      out = out.replace(outboxLine, `${m[0]}${m[1]}${provider}\n`);
    } else {
      const shutdown = /^([ \t]*)OrmShutdown,/m;
      const k = shutdown.exec(out);
      if (!k) return undefined;
      out = out.replace(shutdown, `${k[1]}${provider}\n${k[0]}`);
    }
    return appendToExports(out, 'RECONCILIATION_REPOSITORY');
  },
  'acrescente o provider de RECONCILIATION_REPOSITORY (MikroReconciliationRepository) junto dos outros repositórios e o token nos exports (passo 6).',
);

// ------------------------------------------------------------------ wallet.module.ts

edit(
  'src/modules/wallet/wallet.module.ts',
  'registrar alertas e ReconcileWalletsUseCase',
  (s) => s.includes('provide: ReconcileWalletsUseCase'),
  (s) => {
    let out = s;
    for (const line of [
      "import { METRICS, type Metrics } from '../../platform/observability/metrics';",
      "import { RECONCILIATION_ALERTS, type ReconciliationAlerts } from './application/ports/reconciliation-alerts.port';",
      "import { RECONCILIATION_REPOSITORY, type ReconciliationRepository } from './application/ports/reconciliation.repository';",
      "import { ReconcileWalletsUseCase } from './application/reconcile-wallets.use-case';",
      "import { LoggingReconciliationAlerts } from './infrastructure/reconciliation/logging-reconciliation-alerts';",
    ]) out = addImport(out, line);

    const providers = `    {
      provide: RECONCILIATION_ALERTS,
      useFactory: (metrics: Metrics) => new LoggingReconciliationAlerts(metrics),
      inject: [METRICS],
    },
    {
      provide: ReconcileWalletsUseCase,
      useFactory: (tm: TransactionManager, repository: ReconciliationRepository, alerts: ReconciliationAlerts, clock: Clock) =>
        new ReconcileWalletsUseCase(tm, repository, alerts, clock),
      inject: [TRANSACTION_MANAGER, RECONCILIATION_REPOSITORY, RECONCILIATION_ALERTS, CLOCK],
    },
`;
    // fim do array de providers: a linha "  ]," logo antes de "exports" ou de "})"
    const end = /\n  \],\n(?=(?:\s*exports:[^\n]*\n)?\}\))/;
    if (!end.test(out)) return undefined;
    out = out.replace(end, `\n${providers}  ],\n`);
    if (out.includes('exports: [')) return appendToExports(out, 'ReconcileWalletsUseCase');
    return out.replace(/\n  \],\n\}\)/, '\n  ],\n  exports: [ReconcileWalletsUseCase],\n})');
  },
  'acrescente os providers RECONCILIATION_ALERTS e ReconcileWalletsUseCase no fim do array de providers e `exports: [ReconcileWalletsUseCase]` (passo 6).',
);

// ------------------------------------------------------------------ wallets.controller.ts

edit(
  'src/modules/wallet/infrastructure/http/wallets.controller.ts',
  'rota POST /wallets/:walletId/reconciliation',
  (s) => s.includes("':walletId/reconciliation'"),
  (s) => {
    let out = addImport(s, "import { ReconcileWalletsUseCase, type WalletReconciliation } from '../../application/reconcile-wallets.use-case';");
    const ctor = /(private readonly listLedger: ListLedgerQuery,)(\s*)\)\s*\{\s*\}/;
    if (!ctor.test(out)) return undefined;
    out = out.replace(ctor, `$1
    private readonly reconcileWallets: ReconcileWalletsUseCase,
  ) {}

  /**
   * Compara o saldo gravado com o saldo reconstruído pelo ledger. Somente leitura:
   * uma divergência volta no relatório (200), é registrada em log e métrica, e o saldo NÃO é alterado.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<WalletReconciliation> {
    return this.reconcileWallets.reconcile(parseUuidParam('walletId', walletId));
  }`);
    return out;
  },
  'acrescente `private readonly reconcileWallets: ReconcileWalletsUseCase` ao construtor e a rota `@Post(\':walletId/reconciliation\')` (passo 6).',
);

// ------------------------------------------------------------------ package.json

edit(
  'package.json',
  'script "reconcile"',
  (s) => JSON.parse(s).scripts?.reconcile !== undefined,
  (s) => {
    const pkg = JSON.parse(s);
    pkg.scripts = { ...pkg.scripts, reconcile: 'bun scripts/reconcile.ts' };
    return `${JSON.stringify(pkg, null, 2)}\n`;
  },
  'acrescente "reconcile": "bun scripts/reconcile.ts" aos scripts.',
);

// ------------------------------------------------------------------ relatório

const width = Math.max(...results.map((r) => r.file.length));
for (const r of results) {
  const mark = r.status === 'FALHOU' ? '✗' : r.status === 'aplicado' ? '✓' : '·';
  console.log(`  ${mark} ${r.file.padEnd(width)}  ${r.change} (${r.status})`);
  if (r.hint) console.log(`      → faça à mão: ${r.hint}`);
}
process.exit(results.some((r) => r.status === 'FALHOU') ? 1 : 0);
ETAPA17_EOF
if ! bun "$PATCHER"; then
  rm -rf "$WORKDIR"
  fail "algumas edições não puderam ser aplicadas automaticamente (veja as linhas ✗ acima). Faça-as à mão e rode o script de novo."
fi
rm -rf "$WORKDIR"

say "3/4 Typecheck"
if grep -q '"typecheck"' package.json; then bun run typecheck; else bunx tsc --noEmit -p .; fi

if [ "$RUN_TESTS" = "1" ]; then
  say "4/4 Testes da etapa 17 (precisa do Postgres: bun run infra:up)"
  bun test --timeout 60000 test/integration/wallet
else
  say "4/4 Testes pulados (--no-tests)"
fi

say "Pronto."
cat <<'NEXT'
Próximos passos:
  1. Revise o diff:            git diff && git status
  2. Rode a regressão:         bun test --timeout 300000 test/integration test/concurrency test/resilience
  3. Experimente o comando:    bun run reconcile
  4. Commits sugeridos:
       git add src && git commit -m "feat(wallet): read-only reconciliation of stored balance against the ledger"
       git add scripts/reconcile.ts package.json && git commit -m "feat(ops): reconcile command for all wallets with exit codes"
       git add test/integration/wallet && git commit -m "test(wallet): reconciliation detection, metrics, paging, concurrency and command"
  5. Documentação (README e ADR-016): copie as seções da resposta da etapa 17
     para os lugares certos do README.md e do ARCHITECTURE.md.
NEXT