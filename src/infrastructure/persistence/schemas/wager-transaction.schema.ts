import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceSnapshot: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'string' },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    balanceSnapshot: { type: 'string', nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    expiresAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});
