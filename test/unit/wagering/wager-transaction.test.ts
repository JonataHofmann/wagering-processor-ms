import {
  SYSTEM_PROVIDER_ID,
  WagerTransaction,
} from '@/src/modules/wagering/domain/entities/wager-transaction';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '@/src/modules/wagering/error/wager-transaction.errors';
import {
  HASH_A,
  T0,
  brl,
  buildReferencing,
  buildTransaction,
  processed,
} from '@/test/support/wagering-builders';
import { describe, expect, test } from 'bun:test';

import { WagerTransactionKind as Kind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { DomainError } from '@/src/shared/error/domain-error';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

const LATER = new Date('2026-01-01T00:01:00.000Z');
const EXPIRES = new Date('2026-01-01T00:15:00.000Z');

function validationCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof InvalidWagerTransactionError
      ? error.code
      : 'OTHER_ERROR';
  }
}

// ================================================================= rules per kind

describe('BET', () => {
  test('starts PENDING, debits, moves balance and does not accept a reference', () => {
    const bet = buildTransaction({ kind: Kind.Bet });
    expect(bet.status).toBe(Status.Pending);
    expect(bet.attempts).toBe(0);
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(
      validationCode(() =>
        buildTransaction({
          kind: Kind.Bet,
          referenceExternalTransactionId: 'x',
        }),
      ),
    ).toBe('REFERENCE_NOT_ALLOWED');
  });

  test('insufficient balance in BET is INSUFFICIENT_FUNDS', () => {
    expect(
      buildTransaction({ kind: Kind.Bet }).insufficientFundsFailureCode(),
    ).toBe(FailureCode.InsufficientFunds);
  });
});

describe('WIN', () => {
  test('credits, with or without a reference to BET', () => {
    const bet = buildTransaction();
    const winWithRef = buildReferencing(Kind.Win, bet);
    const winWithoutRef = buildTransaction({ kind: Kind.Win });

    expect(winWithRef.referenceExternalTransactionId).toBe(
      bet.externalTransactionId,
    );
    expect(winWithoutRef.referenceExternalTransactionId).toBeUndefined();
    expect(winWithRef.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(winWithRef.requiresReference()).toBe(false);
  });
});

describe('LOSS', () => {
  test('does not move balance, has no ledger direction and does not accept a reference', () => {
    const loss = buildTransaction({ kind: Kind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(
      validationCode(() =>
        buildTransaction({
          kind: Kind.Loss,
          referenceExternalTransactionId: 'x',
        }),
      ),
    ).toBe('REFERENCE_NOT_ALLOWED');
  });
});

describe('REFUND', () => {
  test('requires a reference and credits', () => {
    expect(validationCode(() => buildTransaction({ kind: Kind.Refund }))).toBe(
      'REFERENCE_REQUIRED',
    );
    expect(
      validationCode(() =>
        buildTransaction({
          kind: Kind.Refund,
          referenceExternalTransactionId: '  ',
        }),
      ),
    ).toBe('REFERENCE_REQUIRED');

    const refund = buildReferencing(Kind.Refund, buildTransaction());
    expect(refund.requiresReference()).toBe(true);
    expect(refund.isReversal()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('ROLLBACK', () => {
  test('requires a reference', () => {
    expect(
      validationCode(() => buildTransaction({ kind: Kind.Rollback })),
    ).toBe('REFERENCE_REQUIRED');
  });

  test.each([
    ['BET', Kind.Bet, LedgerDirection.Credit],
    ['WIN', Kind.Win, LedgerDirection.Debit],
    ['REFUND', Kind.Refund, LedgerDirection.Debit],
  ])(
    'ROLLBACK of %s reverses the direction of the reference',
    (_, referenceKind, expected) => {
      const reference =
        referenceKind === Kind.Refund
          ? buildReferencing(Kind.Refund, buildTransaction())
          : buildTransaction({ kind: referenceKind });
      const rollback = buildReferencing(Kind.Rollback, reference);
      expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
    },
  );

  test('without the reference in hand there is no way to determine the direction', () => {
    const rollback = buildReferencing(Kind.Rollback, buildTransaction());
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvariantViolationError,
    );
  });

  test('insufficient balance in ROLLBACK is REVERSAL_INSUFFICIENT_FUNDS, distinct from the bet', () => {
    const rollback = buildReferencing(
      Kind.Rollback,
      buildTransaction({ kind: Kind.Win }),
    );
    expect(rollback.insufficientFundsFailureCode()).toBe(
      FailureCode.ReversalInsufficientFunds,
    );
  });
});

describe('payload validation', () => {
  test('OPENING cannot be submitted by a provider', () => {
    expect(validationCode(() => buildTransaction({ kind: Kind.Opening }))).toBe(
      'OPENING_NOT_ALLOWED',
    );
  });

  test('the "system" provider is reserved', () => {
    expect(
      validationCode(() =>
        buildTransaction({ providerId: SYSTEM_PROVIDER_ID }),
      ),
    ).toBe('RESERVED_PROVIDER');
  });

  test('zero amount is rejected', () => {
    expect(validationCode(() => buildTransaction({ money: brl('0.00') }))).toBe(
      'NON_POSITIVE_AMOUNT',
    );
  });

  test('validation errors are DomainError (become HTTP 400)', () => {
    expect(() => buildTransaction({ kind: Kind.Opening })).toThrow(DomainError);
  });

  test('createOpening generates the internal opening transaction', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'w-1',
      playerId: 'p-1',
      money: brl('100.00'),
      payloadHash: HASH_A,
      createdAt: T0,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.providerId).toBe(SYSTEM_PROVIDER_ID);
    expect(opening.idempotencyKey).toBe('opening:w-1');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

// ================================================================= transitions

describe('transitions from PENDING', () => {
  test('→ PROCESSED records the date and observed balance', () => {
    const bet = buildTransaction();
    bet.markProcessed({ at: LATER, balanceSnapshot: brl('90.00') });
    expect(bet.status).toBe(Status.Processed);
    expect(bet.processedAt).toEqual(LATER);
    expect(bet.balanceSnapshot?.amount).toBe('90.00');
    expect(bet.isTerminal()).toBe(true);
  });

  test('→ REJECTED records the code and observed balance', () => {
    const bet = buildTransaction();
    bet.reject(FailureCode.InsufficientFunds, { balanceSnapshot: brl('5.00') });
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.balanceSnapshot?.amount).toBe('5.00');
  });

  test('→ FAILED records the failure code', () => {
    const bet = buildTransaction();
    bet.fail(FailureCode.InfraRetriesExhausted);
    expect(bet.status).toBe(Status.Failed);
    expect(bet.failureCode).toBe(FailureCode.InfraRetriesExhausted);
  });

  test('reject only accepts rejection codes; fail only accepts failure codes', () => {
    expect(() =>
      buildTransaction().reject(FailureCode.InfraRetriesExhausted, {
        balanceSnapshot: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      buildTransaction().fail(FailureCode.InsufficientFunds),
    ).toThrow(InvariantViolationError);
  });
});

describe('PENDING_REFERENCE cycle', () => {
  test('waits, retries and processes when the reference arrives', () => {
    const bet = processed(buildTransaction());
    const refund = buildReferencing(Kind.Refund, bet);

    refund.markPendingReference({ nextAttemptAt: LATER, expiresAt: EXPIRES });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.isTerminal()).toBe(false);

    refund.rescheduleReferenceLookup(new Date('2026-01-01T00:02:00.000Z'));
    refund.rescheduleReferenceLookup(new Date('2026-01-01T00:04:00.000Z'));
    expect(refund.attempts).toBe(2);

    refund.markProcessed({
      at: LATER,
      balanceSnapshot: brl('100.00'),
      referenceTransactionId: bet.id,
    });
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('expires and becomes REJECTED with REFERENCE_NOT_FOUND', () => {
    const refund = buildReferencing(Kind.Refund, buildTransaction());
    refund.markPendingReference({ nextAttemptAt: LATER, expiresAt: EXPIRES });

    expect(refund.isReferenceLookupExpired(LATER)).toBe(false);
    expect(refund.isReferenceLookupExpired(EXPIRES)).toBe(true);

    refund.reject(FailureCode.ReferenceNotFound, {
      balanceSnapshot: brl('90.00'),
    });
    expect(refund.status).toBe(Status.Rejected);
  });

  test('only something with a reference can wait', () => {
    expect(() =>
      buildTransaction().markPendingReference({
        nextAttemptAt: LATER,
        expiresAt: EXPIRES,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rescheduling only makes sense in PENDING_REFERENCE', () => {
    expect(() =>
      buildReferencing(
        Kind.Refund,
        buildTransaction(),
      ).rescheduleReferenceLookup(LATER),
    ).toThrow(InvalidTransactionStateError);
  });

  test('processing requires the resolved reference, and only when there is a reference', () => {
    const refund = buildReferencing(Kind.Refund, buildTransaction());
    expect(() =>
      refund.markProcessed({ at: LATER, balanceSnapshot: brl('1.00') }),
    ).toThrow(InvariantViolationError);

    const bet = buildTransaction();
    expect(() =>
      bet.markProcessed({
        at: LATER,
        balanceSnapshot: brl('1.00'),
        referenceTransactionId: 'x',
      }),
    ).toThrow(InvariantViolationError);
  });
});

// ================================================================= terminal states

describe('terminal states', () => {
  const makeTerminal: Record<string, () => WagerTransaction> = {
    PROCESSED: () => processed(buildTransaction()),
    REJECTED: () => {
      const tx = buildTransaction();
      tx.reject(FailureCode.InsufficientFunds, {
        balanceSnapshot: brl('1.00'),
      });
      return tx;
    },
    FAILED: () => {
      const tx = buildTransaction();
      tx.fail(FailureCode.InfraRetriesExhausted);
      return tx;
    },
  };

  const actions: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) =>
      tx.markProcessed({ at: LATER, balanceSnapshot: brl('1.00') }),
    reject: (tx) =>
      tx.reject(FailureCode.AmountMismatch, { balanceSnapshot: brl('1.00') }),
    fail: (tx) => tx.fail(FailureCode.InfraRetriesExhausted),
    markPendingReference: (tx) =>
      tx.markPendingReference({ nextAttemptAt: LATER, expiresAt: EXPIRES }),
    rescheduleReferenceLookup: (tx) => tx.rescheduleReferenceLookup(LATER),
  };

  const cases = Object.keys(makeTerminal).flatMap((status) =>
    Object.keys(actions).map((action) => [status, action] as const),
  );

  test.each(cases)('%s does not accept %s and remains unchanged', (status, action) => {
    const tx = makeTerminal[status]!();
    const before = {
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.balanceSnapshot?.amount,
    };

    expect(() => actions[action]!(tx)).toThrow(InvalidTransactionStateError);
    expect({
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.balanceSnapshot?.amount,
    }).toEqual(before);
  });

  test('illegal transition is a bug, not a business rule', () => {
    const tx = processed(buildTransaction());
    try {
      tx.fail(FailureCode.InfraRetriesExhausted);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantViolationError);
      expect(error).not.toBeInstanceOf(DomainError);
    }
  });

  test('isTerminal is only true for PROCESSED, REJECTED and FAILED', () => {
    expect(buildTransaction().isTerminal()).toBe(false);
    for (const make of Object.values(makeTerminal))
      expect(make().isTerminal()).toBe(true);
  });
});

// ================================================================= matchesPayload

describe('matchesPayload', () => {
  test('same hash is the same payload (replay)', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload(HASH_A),
    ).toBe(true);
  });

  test('different hash is a conflict, not a replay', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload('b'.repeat(64)),
    ).toBe(false);
  });

  test('the comparison is exact (no case normalization)', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload(
        HASH_A.toUpperCase(),
      ),
    ).toBe(false);
  });

  test('works the same in terminal transactions', () => {
    expect(
      processed(buildTransaction({ payloadHash: HASH_A })).matchesPayload(
        HASH_A,
      ),
    ).toBe(true);
  });
});

// ================================================================= rehydrate

describe('rehydrate', () => {
  test('restores terminal state without revalidating, and transitions remain blocked', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-db',
      providerId: 'provider-a',
      externalTransactionId: 'e',
      idempotencyKey: 'provider-a:e',
      payloadHash: HASH_A,
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('10.00'),
      createdAt: T0,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balanceSnapshot: brl('3.00'),
      attempts: 0,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(() =>
      tx.markProcessed({ at: LATER, balanceSnapshot: brl('1.00') }),
    ).toThrow(InvalidTransactionStateError);
  });
});
