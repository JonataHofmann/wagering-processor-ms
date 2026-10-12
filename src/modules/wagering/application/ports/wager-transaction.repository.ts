import { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WagerTransactionRepository',
);
