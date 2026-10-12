import { EventContext, IntegrationEvent } from "@/src/shared/domain/integration-event";
import { TransactionSummary, summarize } from "@/src/modules/wagering/domain/events/transaction-summary";

import { InvariantViolationError } from "@/src/shared/error/invariant-violation-error";
import { WagerTransaction } from "@/src/modules/wagering/domain/wager-transaction";
import { WagerTransactionStatus } from "@/src/modules/wagering/domain/wager-transaction-status";

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  attempts: number;
  nextAttemptAt: string;
  expiresAt: string;
}

/** A referência ainda não chegou; a transação vai ser reprocessada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !tx.nextAttemptAt ||
      !tx.expiresAt
    ) {
      throw new InvariantViolationError(
        `WagerTransactionPendingReference requires a PENDING_REFERENCE transaction, got ${tx.status}`,
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...summarize(tx),
        attempts: tx.attempts,
        nextAttemptAt: tx.nextAttemptAt.toISOString(),
        expiresAt: tx.expiresAt.toISOString(),
      },
    });
  }
}
