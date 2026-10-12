import {
  CreateWagerTransactionProps,
  WagerTransaction,
} from '@/src/modules/wagering/domain/wager-transaction';

import { WagerTransactionKind as Kind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { Money } from '@/src/shared/domain/money';

export const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money =>
  Money.from({ amount, currency: 'USD' });
export const HASH_A = 'a'.repeat(64);
export const T0 = new Date('2026-01-01T00:00:00.000Z');

let counter = 0;

/** Transação válida com padrões; por padrão, uma BET de 10.00 BRL. */
export function buildTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  counter += 1;
  const externalTransactionId =
    overrides.externalTransactionId ?? `ext-${counter}`;
  return WagerTransaction.create({
    id: `tx-${counter}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH_A,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('10.00'),
    createdAt: T0,
    ...overrides,
  });
}

/** Transação que referencia outra, com mesmo valor e contexto por padrão. */
export function buildReferencing(
  kind: Kind.Win | Kind.Refund | Kind.Rollback,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return buildTransaction({
    kind,
    money: reference.money,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

/** Marca como PROCESSED (resolvendo a referência quando houver). */
export function processed(
  tx: WagerTransaction,
  reference?: WagerTransaction,
): WagerTransaction {
  tx.markProcessed({
    at: T0,
    balanceSnapshot: brl('90.00'),
    referenceTransactionId: reference?.id,
  });
  return tx;
}
