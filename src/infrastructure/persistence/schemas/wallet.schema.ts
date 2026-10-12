import { EntitySchema } from '@mikro-orm/core';

/** Linha da tabela wallets, como o banco a vê. Não é o aggregate de domínio. */
export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string; // numeric: o driver pg devolve string, nunca float
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string' },
    balance: { type: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});
