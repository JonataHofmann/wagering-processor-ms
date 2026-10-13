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
