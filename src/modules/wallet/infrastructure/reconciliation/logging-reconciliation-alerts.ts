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
