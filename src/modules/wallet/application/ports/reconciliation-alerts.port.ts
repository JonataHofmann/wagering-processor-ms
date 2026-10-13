import type { WalletReconciliation } from '../reconcile-wallets.use-case';

/** Para onde vai o resultado de cada verificação (logs e métricas). */
export interface ReconciliationAlerts {
  walletChecked(report: WalletReconciliation): void;
  fullRunCompleted(summary: { checked: number; divergent: number }): void;
}

export const RECONCILIATION_ALERTS = Symbol('ReconciliationAlerts');
