import { WagerTransactionRecord } from '@/src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { Money } from '@/src/shared/domain/money';
import { nul } from '@/src/shared/util/nul';
import { undef } from '@/src/shared/util/undef';

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string): Money =>
      Money.from({ amount, currency: r.currency });
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount),
      referenceExternalTransactionId: undef(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: undef(r.referenceTransactionId),
      failureCode: undef(r.failureCode) as FailureCode | undefined,
      processedAt: undef(r.processedAt),
      balanceSnapshot:
        r.balanceSnapshot === null ? undefined : money(r.balanceSnapshot),
      attempts: r.attempts,
      nextAttemptAt: undef(r.nextAttemptAt),
      expiresAt: undef(r.expiresAt),
    });
  },

  /** Colunas que mudam ao longo do ciclo de vida (as demais são imutáveis no banco). */
  toLifecycleColumns(tx: WagerTransaction) {
    return {
      status: tx.status as string,
      referenceTransactionId: nul(tx.referenceTransactionId),
      failureCode: nul(tx.failureCode) as string | null,
      balanceSnapshot: tx.balanceSnapshot?.amount ?? null,
      attempts: tx.attempts,
      nextAttemptAt: nul(tx.nextAttemptAt),
      expiresAt: nul(tx.expiresAt),
      processedAt: nul(tx.processedAt),
    };
  },

  toRecord(tx: WagerTransaction, now: Date): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: nul(tx.referenceExternalTransactionId),
      createdAt: tx.createdAt,
      updatedAt: now,
      ...WagerTransactionMapper.toLifecycleColumns(tx),
    };
  },
};
