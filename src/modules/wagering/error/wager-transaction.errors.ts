import { DomainError } from '@/src/shared/error/domain-error';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export type InvalidWagerTransactionCode =
  | 'OPENING_NOT_ALLOWED' // OPENING é interno
  | 'RESERVED_PROVIDER' // provider "system" é reservado
  | 'REFERENCE_REQUIRED' // REFUND/ROLLBACK sem referência
  | 'REFERENCE_NOT_ALLOWED' // BET/LOSS com referência
  | 'NON_POSITIVE_AMOUNT'; // valor zero

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    public readonly code: InvalidWagerTransactionCode,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, status: string, action: string) {
    super(`cannot ${action} transaction ${transactionId} in status ${status}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class DuplicateWagerTransactionError extends DomainError {
  readonly code = 'DUPLICATE_TRANSACTION';

  constructor(public readonly idempotencyKey: string) {
    super(
      `a transaction with idempotency key ${idempotencyKey} already exists`,
    );
  }
}
