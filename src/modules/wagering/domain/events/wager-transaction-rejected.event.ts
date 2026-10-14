import {
  TransactionSummary,
  summarize,
} from '@/src/modules/wagering/domain/events/transaction-summary';
import {
  EventContext,
  IntegrationEvent,
} from '@/src/shared/domain/integration-event';

import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { MoneyProps } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: FailureCode;
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio (inclusive referência expirada). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (
      tx.status !== WagerTransactionStatus.Rejected ||
      !tx.failureCode ||
      !tx.balanceSnapshot
    ) {
      throw new InvariantViolationError(
        `WagerTransactionRejected requires a REJECTED transaction, got ${tx.status}`,
      );
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...summarize(tx),
        failureCode: tx.failureCode,
        balance: tx.balanceSnapshot.toJSON(),
      },
    });
  }
}
