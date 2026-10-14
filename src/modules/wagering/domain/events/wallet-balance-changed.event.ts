import {
  EventContext,
  IntegrationEvent,
} from '@/src/shared/domain/integration-event';

import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';
import { MoneyProps } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (
      entry.walletId !== wallet.id ||
      entry.walletVersion !== wallet.version
    ) {
      throw new InvariantViolationError(
        `entry ${entry.id} (v${entry.walletVersion}) does not describe the current state of wallet ${wallet.id} (v${wallet.version})`,
      );
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
