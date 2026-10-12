import { FailureCode } from "@/src/modules/wagering/error/failure-code";
import { MoneyProps } from "@/src/shared/domain/money";
import { WagerTransaction } from "@/src/modules/wagering/domain/wager-transaction";
import { WagerTransactionStatus } from "@/src/modules/wagering/domain/wager-transaction-status";

/** Resposta do POST /wagering/transactions (nova ou replay). */
export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  /** saldo observado quando a operação foi decidida; null enquanto pendente */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

/** Consulta de uma transação. */
export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  attempts: number;
  createdAt: string;
  processedAt: string | null;
}

/**
 * Saldo observado, exceto quando a operação apontou para a wallet de OUTRO jogador:
 * não devolvemos o saldo de uma wallet a quem não é o dono dela.
 */
function visibleBalance(tx: WagerTransaction): MoneyProps | null {
  if (tx.failureCode === FailureCode.WalletPlayerMismatch) return null;
  return tx.balanceSnapshot?.toJSON() ?? null;
}

export function toTransactionResult(
  tx: WagerTransaction,
  idempotentReplay: boolean,
): TransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: visibleBalance(tx),
    idempotentReplay,
  };
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: visibleBalance(tx),
    attempts: tx.attempts,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
