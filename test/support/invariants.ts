import { queryOnce } from './pg';

export async function walletsInconsistentWithLedger(databaseUrl: string) {
  return queryOnce<{ wallet_id: string; stored: string; replayed: string }>(
    databaseUrl,
    `
    SELECT w.id AS wallet_id, w.balance::text AS stored, COALESCE(SUM(
             CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS replayed
      FROM wallets w
      LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)`,
  );
}
