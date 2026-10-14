import type {
  ReconciliationRepository,
  WalletLedgerSnapshot,
} from '../ports/reconciliation.repository';

import type { Clock } from '../../../../shared/application/ports/clock.port';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { ReconciliationAlerts } from '../ports/reconciliation-alerts.port';
import { ResourceNotFoundError } from '../../../../shared/error/application-errors';
import type { TransactionManager } from '../../../../shared/application/ports/transaction-manager.port';

export type DiscrepancyCode =
  | 'BALANCE_MISMATCH' // saldo gravado ≠ soma do ledger (a verificação exigida pelo enunciado)
  | 'LAST_ENTRY_MISMATCH' // saldo gravado ≠ balance_after do último lançamento
  | 'VERSION_MISMATCH' // versão da wallet ≠ versão do último lançamento
  | 'LEDGER_CHAIN_BROKEN' // um lançamento não começa onde o anterior terminou
  | 'LEDGER_VERSION_GAP'; // falta um lançamento na sequência de versões

export interface Discrepancy {
  code: DiscrepancyCode;
  detail: string;
}

export interface WalletReconciliation {
  walletId: string;
  consistent: boolean;
  storedBalance: MoneyProps;
  /** saldo reconstruído a partir do ledger (chamado "calculatedBalance" no enunciado) */
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  walletVersion: number;
  /** lançamentos conferidos (chamado "checkedEntries" no enunciado) */
  checkedEntries: number;
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
    found.push({
      code: 'BALANCE_MISMATCH',
      detail: `stored ${s.storedBalance} vs ledger ${s.ledgerBalance} (difference ${s.difference})`,
    });
  }

  if (s.ledgerEntries === 0) {
    // wallet aberta com saldo zero e nunca movimentada: versão 1, saldo 0
    if (s.walletVersion !== 1)
      found.push({
        code: 'VERSION_MISMATCH',
        detail: `version ${s.walletVersion} without ledger entries`,
      });
  } else {
    if (s.lastBalanceAfter !== null && s.storedBalance !== s.lastBalanceAfter) {
      found.push({
        code: 'LAST_ENTRY_MISMATCH',
        detail: `stored ${s.storedBalance} vs last entry ${s.lastBalanceAfter}`,
      });
    }
    if (s.lastLedgerVersion !== s.walletVersion) {
      found.push({
        code: 'VERSION_MISMATCH',
        detail: `wallet version ${s.walletVersion} vs last entry version ${s.lastLedgerVersion}`,
      });
    }
  }
  if (s.chainBreaks > 0)
    found.push({
      code: 'LEDGER_CHAIN_BROKEN',
      detail: `${s.chainBreaks} entries do not start where the previous ended`,
    });
  if (s.versionGaps > 0)
    found.push({
      code: 'LEDGER_VERSION_GAP',
      detail: `${s.versionGaps} gaps in the wallet_version sequence`,
    });

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
    const snapshot = await this.transactionManager.runInTransaction(() =>
      this.repository.snapshotOf(walletId),
    );
    if (snapshot === undefined)
      throw new ResourceNotFoundError(
        'WALLET_NOT_FOUND',
        `wallet ${walletId} not found`,
      );
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
        this.repository.snapshotPage({ afterWalletId, limit: pageSize }),
      );
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
    const money = (amount: string): MoneyProps => ({
      amount,
      currency: s.currency,
    });
    return {
      walletId: s.walletId,
      consistent: discrepancies.length === 0,
      storedBalance: money(s.storedBalance),
      calculatedBalance: money(s.ledgerBalance),
      difference: money(s.difference),
      walletVersion: s.walletVersion,
      checkedEntries: s.ledgerEntries,
      lastLedgerVersion: s.lastLedgerVersion,
      discrepancies,
      checkedAt: this.clock.now().toISOString(),
    };
  }
}
