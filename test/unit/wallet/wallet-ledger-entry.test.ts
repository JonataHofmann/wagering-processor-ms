import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { DomainError } from '@/src/shared/error/domain-error';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { describe, expect, test } from 'bun:test';
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

function props(
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  test('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedMoney().amount).toBe('-25.00');
  });

  test('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceAfter: brl('125.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedMoney().amount).toBe('25.00');
  });

  test.each([
    ['wrong arithmetic', { balanceAfter: brl('80.00') }],
    ['swapped direction', { direction: LedgerDirection.Credit }],
    ['zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    [
      'negative amount',
      { money: brl('25.00').negate(), balanceAfter: brl('125.00') },
    ],
    [
      'negative final balance',
      {
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00').subtract(brl('25.00')),
      },
    ],
    ['different amount currency', { money: usd('25.00') }],
    ['different final balance currency', { balanceAfter: usd('75.00') }],
    ['zero version', { walletVersion: 0 }],
    ['fractional version', { walletVersion: 1.5 }],
  ])('rejects %s with InvariantViolationError', (_, overrides) => {
    expect(() =>
      WalletLedgerEntry.create(
        props(overrides as Partial<CreateLedgerEntryProps>),
      ),
    ).toThrow(InvariantViolationError);
  });

  test('invariant violation is not a DomainError: a bug never becomes a business rejection', () => {
    try {
      WalletLedgerEntry.create(props({ balanceAfter: brl('80.00') }));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantViolationError);
      expect(error).not.toBeInstanceOf(DomainError);
    }
  });
});

describe('immutability', () => {
  test('the entry is frozen', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0.00');
    }).toThrow();
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstructs without revalidating, as required by rule 6.0', () => {
    const corrupted = WalletLedgerEntry.rehydrate(
      props({ balanceAfter: brl('80.00') }),
    );
    expect(corrupted.balanceAfter.amount).toBe('80.00');
    expect(corrupted.isBalanced()).toBe(false); // detectable, but not blocked on read
  });
});
