import { FixedClock, SequentialIdGenerator } from '@/test/support/fakes';
import { beforeEach, describe, expect, test } from 'bun:test';

import { CurrencyMismatchError } from '@/src/shared/error/currency-mismatch-error';
import { DomainError } from '@/src/shared/error/domain-error';
import { InsufficientFundsError } from '@/src/modules/wallet/error/wallet.errors';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

let ids: SequentialIdGenerator;
let clock: FixedClock;

beforeEach(() => {
  ids = new SequentialIdGenerator();
  clock = new FixedClock('2026-01-01T00:00:00.000Z');
});

function openWallet(initial: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    openedAt: clock.now(),
  });
}

/** Executes a movement with new ids and time; the clock advances 1s on each call. */
function move(
  wallet: Wallet,
  operation: 'debit' | 'credit',
  money: Money,
): WalletLedgerEntry {
  clock.advance(1_000);
  return wallet[operation]({
    money,
    transactionId: ids.next(),
    entryId: ids.next(),
    at: clock.now(),
  });
}

function snapshot(wallet: Wallet) {
  return {
    balance: wallet.balance.amount,
    version: wallet.version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

/** Balance reconstructed by summing the entries (the spec's central invariant). */
function replay(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (total, entry) => total.add(entry.signedMoney()),
    Money.zero('BRL'),
  );
}

// ================================================================ opening

describe('Wallet.open', () => {
  test('zero balance: version 1, no entry', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('0.00');
    expect(openingEntry).toBeUndefined();
  });

  test('initial balance: OPENING CREDIT entry v1 from 0 to the balance', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry).toMatchObject({
      id: 'entry-opening',
      walletId: 'wallet-1',
      transactionId: 'tx-opening',
      walletVersion: 1,
      direction: LedgerDirection.Credit,
    });
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
  });

  test('currency and dates come from the opening', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('negative initial balance is a bug', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('1.00').negate(),
        openingTransactionId: 't',
        openingEntryId: 'e',
        openedAt: clock.now(),
      }),
    ).toThrow(InvariantViolationError);
  });
});

// ================================================== criterion 1: always returns the entry

describe('debit and credit always return the entry', () => {
  test('debit returns the entry that exactly describes the change', () => {
    const { wallet } = openWallet('100.00');
    const entry = move(wallet, 'debit', brl('30.00'));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.amount).toBe('30.00');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.walletVersion).toBe(wallet.version);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.createdAt.getTime()).toBe(wallet.updatedAt.getTime());
  });

  test('credit returns the entry that exactly describes the change', () => {
    const { wallet } = openWallet('100.00');
    const entry = move(wallet, 'credit', brl('50.00'));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('150.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.walletVersion).toBe(wallet.version);
  });

  test('in any sequence, the ledger reconstructs the balance and forms a chain with no gaps', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [openingEntry!];

    entries.push(move(wallet, 'debit', brl('30.00')));
    entries.push(move(wallet, 'credit', brl('50.00')));
    entries.push(move(wallet, 'debit', brl('120.00'))); // zeroes out
    entries.push(move(wallet, 'credit', brl('0.01')));
    entries.push(move(wallet, 'credit', brl('999.99')));
    entries.push(move(wallet, 'debit', brl('500.00')));

    // spec invariant: wallet.balance == balance reconstructed by the ledger
    expect(replay(entries).equals(wallet.balance)).toBe(true);

    // consecutive versions, 1..n, and the last one is the wallet's version
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(wallet.version).toBe(7);

    // each entry starts where the previous one ended
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter),
      ).toBe(true);
    }
    expect(entries.every((e) => e.isBalanced())).toBe(true);
  });
});

// ======================================================= criterion 2: never negative

describe('the balance never goes negative', () => {
  test('a debit larger than the balance is rejected and changes nothing', () => {
    const { wallet } = openWallet('50.00');
    const before = snapshot(wallet);

    expect(() => move(wallet, 'debit', brl('50.01'))).toThrow(
      InsufficientFundsError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test('the rejection is a DomainError with code INSUFFICIENT_FUNDS', () => {
    const { wallet } = openWallet('10.00');
    try {
      move(wallet, 'debit', brl('20.00'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  test('debiting the exact balance zeroes out the wallet', () => {
    const { wallet } = openWallet('50.00');
    move(wallet, 'debit', brl('50.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('a wallet with zero balance does not accept even a single cent of debit', () => {
    const { wallet } = openWallet('0.00');
    expect(() => move(wallet, 'debit', brl('0.01'))).toThrow(
      InsufficientFundsError,
    );
  });

  test('canDebit answers without altering the wallet', () => {
    const { wallet } = openWallet('50.00');
    const before = snapshot(wallet);
    expect(wallet.canDebit(brl('50.00'))).toBe(true);
    expect(wallet.canDebit(brl('50.01'))).toBe(false);
    expect(snapshot(wallet)).toEqual(before);
  });

  test('spec scenario in sequence: 100.00, two bets of 80.00', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [openingEntry!];

    entries.push(move(wallet, 'debit', brl('80.00')));
    expect(() => move(wallet, 'debit', brl('80.00'))).toThrow(
      InsufficientFundsError,
    );

    expect(wallet.balance.amount).toBe('20.00');
    expect(
      entries.filter((e) => e.direction === LedgerDirection.Debit),
    ).toHaveLength(1);
    expect(replay(entries).equals(wallet.balance)).toBe(true);
  });
});

// ================================================ criterion 3: version only on balance change

describe('version only increments when the balance changes', () => {
  test('each successful movement increments exactly 1', () => {
    const { wallet } = openWallet('100.00');
    move(wallet, 'debit', brl('10.00'));
    expect(wallet.version).toBe(2);
    move(wallet, 'credit', brl('10.00'));
    expect(wallet.version).toBe(3);
  });

  test.each([
    ['insufficient balance', () => brl('1000.00'), 'debit' as const],
    ['different currency on debit', () => usd('1.00'), 'debit' as const],
    ['different currency on credit', () => usd('1.00'), 'credit' as const],
    ['zero amount on debit', () => brl('0.00'), 'debit' as const],
    ['zero amount on credit', () => brl('0.00'), 'credit' as const],
  ])(
    'rejected operation (%s) does not change version, balance or date',
    (_, money, operation) => {
      const { wallet } = openWallet('100.00');
      const before = snapshot(wallet);
      expect(() => move(wallet, operation, money())).toThrow();
      expect(snapshot(wallet)).toEqual(before);
    },
  );

  test('queries do not change version', () => {
    const { wallet } = openWallet('100.00');
    wallet.canDebit(brl('10.00'));
    void wallet.balance;
    expect(wallet.version).toBe(1);
  });
});

// ================================================================ errors

describe('error types', () => {
  test('different currency is a business error (CURRENCY_MISMATCH)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => move(wallet, 'credit', usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('zero-amount movement is a bug, not a business rejection', () => {
    const { wallet } = openWallet('100.00');
    expect(() => move(wallet, 'credit', brl('0.00'))).toThrow(
      InvariantViolationError,
    );
  });
});

// ================================================================ rehydrate

describe('Wallet.rehydrate', () => {
  test('restores state without revalidating and continues the version numbering', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-06-01T00:00:00Z'),
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('42.00');

    const entry = move(wallet, 'debit', brl('2.00'));
    expect(entry.walletVersion).toBe(8);
    expect(entry.balanceBefore.amount).toBe('42.00');
    expect(wallet.version).toBe(8);
  });
});
