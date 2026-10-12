import { EntitySchema } from '@mikro-orm/core';

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    direction: { type: 'string' },
    amount: { type: 'string' },
    currency: { type: 'string' },
    balanceBefore: { type: 'string' },
    balanceAfter: { type: 'string' },
    createdAt: { type: 'datetime' },
  },
});
