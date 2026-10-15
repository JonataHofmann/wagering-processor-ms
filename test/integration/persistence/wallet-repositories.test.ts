import { Persistence, createPersistence } from '@/test/support/persistence';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sqlStateOf } from '@/src/infrastructure/persistence/pg-error';
import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { WalletAlreadyExistsError } from '@/src/modules/wallet/error/wallet.errors';
import { Money } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

let p: Persistence;
beforeAll(async () => {
  p = await createPersistence();
});
afterAll(async () => {
  await p.close();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const HASH = 'a'.repeat(64);

/** Opens and persists a wallet the same way the CreateWallet use case will: wallet + OPENING + ledger entry. */
async function persistOpenedWallet(
  initial: string,
  playerId: string = crypto.randomUUID(),
) {
  const openingTransactionId = crypto.randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId,
    initialBalance: brl(initial),
    openingTransactionId,
    openingEntryId: crypto.randomUUID(),
    openedAt: p.clock.now(),
  });
  await p.tm.runInTransaction(async () => {
    await p.wallets.insert(wallet);
    if (openingEntry) {
      const opening = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId,
        money: brl(initial),
        payloadHash: HASH,
        createdAt: p.clock.now(),
      });
      opening.markProcessed({
        at: p.clock.now(),
        balanceSnapshot: wallet.balance,
      });
      await p.transactions.insert(opening);
      await p.ledger.append(openingEntry);
    }
  });
  return wallet;
}

/** Full bet: lock, debit, transaction, ledger entry, update with expected version. */
async function persistBet(walletId: string, amount: string) {
  return p.tm.runInTransaction(async () => {
    const wallet = (await p.wallets.findByIdForUpdate(walletId))!;
    const expectedVersion = wallet.version;
    const bet = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      payloadHash: HASH,
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      createdAt: p.clock.now(),
    });
    const entry = wallet.debit({
      money: brl(amount),
      transactionId: bet.id,
      entryId: crypto.randomUUID(),
      at: p.clock.now(),
    });
    bet.markProcessed({ at: p.clock.now(), balanceSnapshot: wallet.balance });
    await p.wallets.update(wallet, expectedVersion);
    await p.transactions.insert(bet);
    await p.ledger.append(entry);
    return { wallet, entry, bet };
  });
}

describe('WalletRepository', () => {
  test('round trip: what is written comes back identical through rehydrate', async () => {
    const wallet = await persistOpenedWallet('100.00');
    const found = (await p.tm.runInTransaction(() =>
      p.wallets.findById(wallet.id),
    ))!;
    expect(found.balance.amount).toBe('100.00');
    expect(found.balance.currency).toBe('BRL');
    expect(found.version).toBe(1);
    expect(found.playerId).toBe(wallet.playerId);
    expect(found.createdAt.toISOString()).toBe(wallet.createdAt.toISOString());
  });

  test('duplicate wallet for the same player and currency becomes WalletAlreadyExistsError', async () => {
    const playerId = crypto.randomUUID();
    await persistOpenedWallet('0.00', playerId);
    await expect(persistOpenedWallet('0.00', playerId)).rejects.toThrow(
      WalletAlreadyExistsError,
    );
  });

  test('update writes balance and version; the database accepts it because the ledger entry exists', async () => {
    const wallet = await persistOpenedWallet('100.00');
    await persistBet(wallet.id, '30.00');
    const found = (await p.tm.runInTransaction(() =>
      p.wallets.findById(wallet.id),
    ))!;
    expect(found.balance.amount).toBe('70.00');
    expect(found.version).toBe(2);
  });

  test('update with wrong expected version is a bug and writes nothing', async () => {
    const wallet = await persistOpenedWallet('0.00');
    await expect(
      p.tm.runInTransaction(() => p.wallets.update(wallet, 99)),
    ).rejects.toThrow(InvariantViolationError);
  });

  test('findByIdForUpdate locks: another transaction waits and exceeds the lock_timeout', async () => {
    const wallet = await persistOpenedWallet('100.00');

    let releaseFirst!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let lockAcquired!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    const first = p.tm.runInTransaction(async () => {
      await p.wallets.findByIdForUpdate(wallet.id);
      lockAcquired();
      await firstHoldsLock; // holds the lock until the test tells it to release
    });

    await lockTaken;
    const started = Date.now();
    const error = await p.tm
      .runInTransaction(() => p.wallets.findByIdForUpdate(wallet.id))
      .catch((e: unknown) => e);
    releaseFirst();
    await first;

    expect(sqlStateOf(error)).toBe('55P03'); // lock_not_available: becomes a transient error
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900); // waited for the 2s lock_timeout
  });
});

describe('LedgerRepository', () => {
  test('lists ledger entries in version order, with cursor-based pagination', async () => {
    const wallet = await persistOpenedWallet('100.00');
    await persistBet(wallet.id, '10.00');
    await persistBet(wallet.id, '20.00');
    await persistBet(wallet.id, '30.00');

    const all = await p.tm.runInTransaction(() =>
      p.ledger.listByWallet({ walletId: wallet.id, limit: 50 }),
    );
    expect(all.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(all.map((e) => e.balanceAfter.amount)).toEqual([
      '100.00',
      '90.00',
      '70.00',
      '40.00',
    ]);
    expect(all.every((e) => e.isBalanced())).toBe(true);

    const page2 = await p.tm.runInTransaction(() =>
      p.ledger.listByWallet({ walletId: wallet.id, afterVersion: 2, limit: 1 }),
    );
    expect(page2.map((e) => e.walletVersion)).toEqual([3]);
  });

  test('the balance rebuilt from the ledger equals the stored balance', async () => {
    const wallet = await persistOpenedWallet('100.00');
    await persistBet(wallet.id, '12.34');
    await persistBet(wallet.id, '0.66');

    const [stored, entries] = await p.tm.runInTransaction(
      async () =>
        [
          (await p.wallets.findById(wallet.id))!,
          await p.ledger.listByWallet({ walletId: wallet.id, limit: 1000 }),
        ] as const,
    );

    const replayed = entries.reduce(
      (sum, e) => sum.add(e.signedMoney()),
      Money.zero('BRL'),
    );
    expect(replayed.equals(stored.balance)).toBe(true);
    expect(stored.balance.amount).toBe('87.00');
  });
});
