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
