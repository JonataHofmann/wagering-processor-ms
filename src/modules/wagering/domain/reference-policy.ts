import type { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '@/src/modules/wagering/domain/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

/** Quem pode referenciar quem. */
export const ALLOWED_REFERENCE_KINDS: Readonly<
  Partial<Record<Kind, readonly Kind[]>>
> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

export interface ReferenceEvaluation {
  transaction: WagerTransaction;
  /** a transação encontrada por (providerId, referenceExternalTransactionId) */
  reference: WagerTransaction;
  /** já existe REFUND/ROLLBACK PROCESSED desta referência? (consultado pelo caso de uso) */
  referenceAlreadyReversed: boolean;
}

/**
 * Avalia se a referência é válida.
 * Devolve undefined se for, ou o FailureCode da rejeição. Não lança para casos de negócio.
 *
 * Ordem das verificações, da mais estrutural para a mais circunstancial:
 *   1. tipo permitido     → REFERENCE_INVALID_KIND
 *   2. mesmo contexto     → REFERENCE_CONTEXT_MISMATCH
 *   3. referência aplicada → REFERENCE_NOT_PROCESSED
 *   4. mesmo valor (só reversões)  → AMOUNT_MISMATCH
 *   5. ainda não revertida (só reversões) → REFERENCE_ALREADY_REVERSED
 */
export function evaluateReference({
  transaction,
  reference,
  referenceAlreadyReversed,
}: ReferenceEvaluation): FailureCode | undefined {
  const allowed = ALLOWED_REFERENCE_KINDS[transaction.kind];
  if (allowed === undefined) {
    throw new InvariantViolationError(
      `${transaction.kind} does not take a reference`,
    );
  }
  if (
    reference.externalTransactionId !==
    transaction.referenceExternalTransactionId
  ) {
    throw new InvariantViolationError(
      `reference ${reference.externalTransactionId} is not the one requested by ${transaction.id}`,
    );
  }

  if (!allowed.includes(reference.kind)) {
    return FailureCode.ReferenceInvalidKind;
  }

  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameContext) {
    return FailureCode.ReferenceContextMismatch;
  }

  if (reference.status !== Status.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (transaction.isReversal()) {
    if (!transaction.money.equals(reference.money)) {
      return FailureCode.AmountMismatch;
    }
    if (referenceAlreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }

  return undefined;
}
