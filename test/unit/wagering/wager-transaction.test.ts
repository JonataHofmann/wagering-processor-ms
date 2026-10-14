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

// ================================================================= regras por kind

describe('BET', () => {
  test('nasce PENDING, debita, move saldo e não aceita referência', () => {
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

  test('saldo insuficiente em BET é INSUFFICIENT_FUNDS', () => {
    expect(
      buildTransaction({ kind: Kind.Bet }).insufficientFundsFailureCode(),
    ).toBe(FailureCode.InsufficientFunds);
  });
});

describe('WIN', () => {
  test('credita, com ou sem referência à BET', () => {
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
  test('não move saldo, não tem direção de lançamento e não aceita referência', () => {
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
  test('exige referência e credita', () => {
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
  test('exige referência', () => {
    expect(
      validationCode(() => buildTransaction({ kind: Kind.Rollback })),
    ).toBe('REFERENCE_REQUIRED');
  });

  test.each([
    ['BET', Kind.Bet, LedgerDirection.Credit],
    ['WIN', Kind.Win, LedgerDirection.Debit],
    ['REFUND', Kind.Refund, LedgerDirection.Debit],
  ])(
    'ROLLBACK de %s inverte a direção da referência',
    (_, referenceKind, expected) => {
      const reference =
        referenceKind === Kind.Refund
          ? buildReferencing(Kind.Refund, buildTransaction())
          : buildTransaction({ kind: referenceKind });
      const rollback = buildReferencing(Kind.Rollback, reference);
      expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
    },
  );

  test('sem a referência em mãos não há como definir a direção', () => {
    const rollback = buildReferencing(Kind.Rollback, buildTransaction());
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvariantViolationError,
    );
  });

  test('saldo insuficiente em ROLLBACK é REVERSAL_INSUFFICIENT_FUNDS, distinto da aposta', () => {
    const rollback = buildReferencing(
      Kind.Rollback,
      buildTransaction({ kind: Kind.Win }),
    );
    expect(rollback.insufficientFundsFailureCode()).toBe(
      FailureCode.ReversalInsufficientFunds,
    );
  });
});

describe('validação do payload', () => {
  test('OPENING não pode ser submetido por provedor', () => {
    expect(validationCode(() => buildTransaction({ kind: Kind.Opening }))).toBe(
      'OPENING_NOT_ALLOWED',
    );
  });

  test('o provider "system" é reservado', () => {
    expect(
      validationCode(() =>
        buildTransaction({ providerId: SYSTEM_PROVIDER_ID }),
      ),
    ).toBe('RESERVED_PROVIDER');
  });

  test('valor zero é recusado', () => {
    expect(validationCode(() => buildTransaction({ money: brl('0.00') }))).toBe(
      'NON_POSITIVE_AMOUNT',
    );
  });

  test('erros de validação são DomainError (viram HTTP 400)', () => {
    expect(() => buildTransaction({ kind: Kind.Opening })).toThrow(DomainError);
  });

  test('createOpening gera a transação interna da abertura', () => {
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

// ================================================================= transições

describe('transições a partir de PENDING', () => {
  test('→ PROCESSED registra data e saldo observado', () => {
    const bet = buildTransaction();
    bet.markProcessed({ at: LATER, balanceSnapshot: brl('90.00') });
    expect(bet.status).toBe(Status.Processed);
    expect(bet.processedAt).toEqual(LATER);
    expect(bet.balanceSnapshot?.amount).toBe('90.00');
    expect(bet.isTerminal()).toBe(true);
  });

  test('→ REJECTED registra o código e o saldo observado', () => {
    const bet = buildTransaction();
    bet.reject(FailureCode.InsufficientFunds, { balanceSnapshot: brl('5.00') });
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.balanceSnapshot?.amount).toBe('5.00');
  });

  test('→ FAILED registra o código de falha', () => {
    const bet = buildTransaction();
    bet.fail(FailureCode.InfraRetriesExhausted);
    expect(bet.status).toBe(Status.Failed);
    expect(bet.failureCode).toBe(FailureCode.InfraRetriesExhausted);
  });

  test('reject só aceita códigos de rejeição; fail só aceita códigos de falha', () => {
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

describe('ciclo de PENDING_REFERENCE', () => {
  test('espera, tenta de novo e processa quando a referência chega', () => {
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

  test('expira e vira REJECTED com REFERENCE_NOT_FOUND', () => {
    const refund = buildReferencing(Kind.Refund, buildTransaction());
    refund.markPendingReference({ nextAttemptAt: LATER, expiresAt: EXPIRES });

    expect(refund.isReferenceLookupExpired(LATER)).toBe(false);
    expect(refund.isReferenceLookupExpired(EXPIRES)).toBe(true);

    refund.reject(FailureCode.ReferenceNotFound, {
      balanceSnapshot: brl('90.00'),
    });
    expect(refund.status).toBe(Status.Rejected);
  });

  test('só espera quem tem referência', () => {
    expect(() =>
      buildTransaction().markPendingReference({
        nextAttemptAt: LATER,
        expiresAt: EXPIRES,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('reagendar só faz sentido em PENDING_REFERENCE', () => {
    expect(() =>
      buildReferencing(
        Kind.Refund,
        buildTransaction(),
      ).rescheduleReferenceLookup(LATER),
    ).toThrow(InvalidTransactionStateError);
  });

  test('processar exige a referência resolvida, e só quando houver referência', () => {
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

// ================================================================= estados terminais

describe('estados terminais', () => {
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

  test.each(cases)('%s não aceita %s e permanece igual', (status, action) => {
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

  test('transição ilegal é bug, não regra de negócio', () => {
    const tx = processed(buildTransaction());
    try {
      tx.fail(FailureCode.InfraRetriesExhausted);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantViolationError);
      expect(error).not.toBeInstanceOf(DomainError);
    }
  });

  test('isTerminal só é verdadeiro para PROCESSED, REJECTED e FAILED', () => {
    expect(buildTransaction().isTerminal()).toBe(false);
    for (const make of Object.values(makeTerminal))
      expect(make().isTerminal()).toBe(true);
  });
});

// ================================================================= matchesPayload

describe('matchesPayload', () => {
  test('mesmo hash é o mesmo payload (replay)', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload(HASH_A),
    ).toBe(true);
  });

  test('hash diferente é conflito, não replay', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload('b'.repeat(64)),
    ).toBe(false);
  });

  test('a comparação é exata (sem normalização de caixa)', () => {
    expect(
      buildTransaction({ payloadHash: HASH_A }).matchesPayload(
        HASH_A.toUpperCase(),
      ),
    ).toBe(false);
  });

  test('funciona igual em transações terminais', () => {
    expect(
      processed(buildTransaction({ payloadHash: HASH_A })).matchesPayload(
        HASH_A,
      ),
    ).toBe(true);
  });
});

// ================================================================= rehydrate

describe('rehydrate', () => {
  test('restaura estado terminal sem revalidar, e as transições continuam bloqueadas', () => {
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
