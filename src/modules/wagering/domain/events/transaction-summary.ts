import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { MoneyProps } from '@/src/shared/domain/money';

/** Campos comuns aos eventos de transação. Só JSON puro. */
export interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

export function summarize(tx: WagerTransaction): TransactionSummary {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  };
}
