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
  claimDuePendingReferences(request: {
    now: Date;
    leaseMs: number;
    limit: number;
  }): Promise<string[]>;

  /** Antecipa para `now` as pendências que esperam por (providerId, externalTransactionId). */
  expediteWaitingFor(
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WagerTransactionRepository',
);
