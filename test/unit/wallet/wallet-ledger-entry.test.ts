import { LedgerDirection } from '@/src/modules/wallet/domain/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { DomainError } from '@/src/shared/error/domain-error';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { describe, expect, test } from 'bun:test';
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from '../../../src/modules/wallet/domain/wallet-ledger-entry';

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
  test('aceita débito balanceado', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedMoney().amount).toBe('-25.00');
  });

  test('aceita crédito balanceado', () => {
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
    ['aritmética errada', { balanceAfter: brl('80.00') }],
    ['direção trocada', { direction: LedgerDirection.Credit }],
    ['valor zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    [
      'valor negativo',
      { money: brl('25.00').negate(), balanceAfter: brl('125.00') },
    ],
    [
      'saldo final negativo',
      {
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00').subtract(brl('25.00')),
      },
    ],
    ['moeda do valor diferente', { money: usd('25.00') }],
    ['moeda do saldo final diferente', { balanceAfter: usd('75.00') }],
    ['versão zero', { walletVersion: 0 }],
    ['versão fracionária', { walletVersion: 1.5 }],
  ])('recusa %s com InvariantViolationError', (_, overrides) => {
    expect(() =>
      WalletLedgerEntry.create(
        props(overrides as Partial<CreateLedgerEntryProps>),
      ),
    ).toThrow(InvariantViolationError);
  });

  test('violação de invariante não é DomainError: bug nunca vira rejeição de negócio', () => {
    try {
      WalletLedgerEntry.create(props({ balanceAfter: brl('80.00') }));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantViolationError);
      expect(error).not.toBeInstanceOf(DomainError);
    }
  });
});

describe('imutabilidade', () => {
  test('o lançamento é congelado', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0.00');
    }).toThrow();
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstrói sem revalidar, como exige a regra 6.0', () => {
    const corrupted = WalletLedgerEntry.rehydrate(
      props({ balanceAfter: brl('80.00') }),
    );
    expect(corrupted.balanceAfter.amount).toBe('80.00');
    expect(corrupted.isBalanced()).toBe(false); // detectável, mas não bloqueado na leitura
  });
});
