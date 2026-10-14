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
import { MoneyProps } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface WagerTransactionProcessedData extends TransactionSummary {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (
      tx.status !== WagerTransactionStatus.Processed ||
      !tx.balanceSnapshot ||
      !tx.processedAt
    ) {
      throw new InvariantViolationError(
        `WagerTransactionProcessed requires a PROCESSED transaction, got ${tx.status}`,
      );
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...summarize(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.balanceSnapshot.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
