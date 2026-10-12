import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '@/src/modules/wagering/error/wager-transaction.errors';

import { WagerTransactionKind as Kind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '@/src/modules/wagering/domain/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { failureCodeInfo } from '@/src/modules/wagering/util/failure-code-info';
import { LedgerDirection } from '@/src/modules/wallet/domain/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export const SYSTEM_PROVIDER_ID = 'system';

const KINDS_REQUIRING_REFERENCE: ReadonlySet<Kind> = new Set([
  Kind.Refund,
  Kind.Rollback,
]);
const KINDS_ALLOWING_REFERENCE: ReadonlySet<Kind> = new Set([
  Kind.Refund,
  Kind.Rollback,
  Kind.Win,
]);
const TERMINAL_STATUSES: ReadonlySet<Status> = new Set([
  Status.Processed,
  Status.Rejected,
  Status.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  /** id da referência NO PROVEDOR, não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceSnapshot?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  expiresAt?: Date;
}

export interface ProcessedOutcome {
  at: Date;
  /** saldo observado ao aplicar; devolvido no replay */
  balanceSnapshot: Money;
  /** id interno da referência resolvida (obrigatório se houver referência) */
  referenceTransactionId?: string;
}

export interface RejectedOutcome {
  /** saldo observado ao rejeitar; devolvido no replay */
  balanceSnapshot: Money;
}

export interface ReferenceSchedule {
  nextAttemptAt: Date;
  expiresAt: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: Status;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _balanceSnapshot: Money | undefined;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _expiresAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._balanceSnapshot = state.balanceSnapshot;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._expiresAt = state.expiresAt;
  }

  // ================================================================ criação

  /** Operação recebida de um provedor. Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING_NOT_ALLOWED',
        'OPENING cannot be submitted by a provider',
      );
    }
    if (props.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        'RESERVED_PROVIDER',
        `provider id "${SYSTEM_PROVIDER_ID}" is reserved`,
      );
    }

    const reference = props.referenceExternalTransactionId?.trim() || undefined;
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (!KINDS_ALLOWING_REFERENCE.has(props.kind) && reference !== undefined) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} must not have a reference`,
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'NON_POSITIVE_AMOUNT',
        `amount must be positive, got ${props.money}`,
      );
    }

    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: reference,
      status: Status.Pending,
      attempts: 0,
    });
  }

  /** Transação interna de abertura da wallet. Só o caso de uso de criar wallet usa. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError(
        `opening amount must be positive, got ${props.money}`,
      );
    }
    return new WagerTransaction({
      id: props.id,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening-${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: Kind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: Status.Pending,
      attempts: 0,
    });
  }

  /** Reconstrução a partir da persistência. NÃO revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  // ================================================================ leitura

  get status(): Status {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceSnapshot(): Money | undefined {
    return this._balanceSnapshot;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get expiresAt(): Date | undefined {
    return this._expiresAt;
  }

  // ================================================================ transições

  /** PENDING | PENDING_REFERENCE → PROCESSED */
  markProcessed(outcome: ProcessedOutcome): void {
    this.assertNotTerminal('markProcessed');

    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (hasReference && outcome.referenceTransactionId === undefined) {
      throw new InvariantViolationError(
        `${this.kind} ${this.id} has a reference that was not resolved`,
      );
    }
    if (!hasReference && outcome.referenceTransactionId !== undefined) {
      throw new InvariantViolationError(
        `${this.kind} ${this.id} has no reference to resolve`,
      );
    }

    this._status = Status.Processed;
    this._processedAt = outcome.at;
    this._balanceSnapshot = outcome.balanceSnapshot;
    this._referenceTransactionId = outcome.referenceTransactionId;
  }

  /** PENDING → PENDING_REFERENCE (primeira espera pela referência) */
  markPendingReference(schedule: ReferenceSchedule): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status !== Status.Pending) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        'markPendingReference',
      );
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError(
        `${this.kind} ${this.id} has no reference to wait for`,
      );
    }

    this._status = Status.PendingReference;
    this._nextAttemptAt = schedule.nextAttemptAt;
    this._expiresAt = schedule.expiresAt;
  }

  /** PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa sem sucesso) */
  rescheduleReferenceLookup(nextAttemptAt: Date): void {
    if (this._status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        'rescheduleReferenceLookup',
      );
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  /** PENDING | PENDING_REFERENCE → REJECTED (regra de negócio) */
  reject(code: FailureCode, outcome: RejectedOutcome): void {
    this.assertNotTerminal('reject');
    if (failureCodeInfo(code).status !== 'REJECTED') {
      throw new InvariantViolationError(
        `${code} is not a rejection code; use fail()`,
      );
    }
    this._status = Status.Rejected;
    this._failureCode = code;
    this._balanceSnapshot = outcome.balanceSnapshot;
  }

  /** PENDING | PENDING_REFERENCE → FAILED (erro permanente de infraestrutura) */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    if (failureCodeInfo(code).status !== 'FAILED') {
      throw new InvariantViolationError(
        `${code} is not a failure code; use reject()`,
      );
    }
    this._status = Status.Failed;
    this._failureCode = code;
  }

  // ================================================================ consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false só para LOSS */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  /** true para REFUND e ROLLBACK */
  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  isReversal(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  /** Mesmo conteúdo de negócio? Mesma key com hash diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Código de saldo insuficiente: reversão sem saldo é operacionalmente diferente de aposta sem saldo. */
  insufficientFundsFailureCode(): FailureCode {
    return this.kind === Kind.Rollback
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
  }

  isReferenceLookupExpired(now: Date): boolean {
    return (
      this._expiresAt !== undefined &&
      now.getTime() >= this._expiresAt.getTime()
    );
  }

  /** Direção do lançamento que esta transação gera. ROLLBACK inverte a da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Opening:
      case Kind.Win:
      case Kind.Refund:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvariantViolationError(
          'LOSS does not move balance and has no ledger direction',
        );
      case Kind.Rollback: {
        if (reference === undefined) {
          throw new InvariantViolationError(
            `ROLLBACK ${this.id} needs its reference to define the direction`,
          );
        }
        if (reference.kind === Kind.Rollback) {
          throw new InvariantViolationError(
            `ROLLBACK ${this.id} cannot reverse another ROLLBACK`,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default: {
        const unreachable: never = this.kind;
        throw new InvariantViolationError(
          `unknown kind ${String(unreachable)}`,
        );
      }
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, action);
    }
  }
}
