import { FixedClock, SequentialIdGenerator } from '@/test/support/fakes';
import { beforeEach, describe, expect, test } from 'bun:test';

import { CurrencyMismatchError } from '@/src/shared/error/currency-mismatch-error';
import { DomainError } from '@/src/shared/error/domain-error';
import { InsufficientFundsError } from '@/src/modules/wallet/error/wallet.errors';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { LedgerDirection } from '@/src/modules/wallet/domain/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { Wallet } from '@/src/modules/wallet/domain/wallet';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/wallet-ledger-entry';

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

/** Executa um movimento com ids e hora novos; o relógio anda 1 s a cada chamada. */
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

/** Saldo reconstruído somando os lançamentos (a invariante central do enunciado). */
function replay(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (total, entry) => total.add(entry.signedMoney()),
    Money.zero('BRL'),
  );
}

// ================================================================ abertura

describe('Wallet.open', () => {
  test('saldo zero: versão 1, sem lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('0.00');
    expect(openingEntry).toBeUndefined();
  });

  test('saldo inicial: lançamento OPENING CREDIT v1 de 0 até o saldo', () => {
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

  test('moeda e datas vêm da abertura', () => {
    const { wallet } = openWallet('10.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('saldo inicial negativo é bug', () => {
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

// ================================================== critério 1: sempre devolve lançamento

describe('debit e credit sempre devolvem o lançamento', () => {
  test('debit devolve o lançamento que descreve exatamente a mudança', () => {
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

  test('credit devolve o lançamento que descreve exatamente a mudança', () => {
    const { wallet } = openWallet('100.00');
    const entry = move(wallet, 'credit', brl('50.00'));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('150.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.walletVersion).toBe(wallet.version);
  });

  test('em qualquer sequência, o ledger reconstrói o saldo e forma uma cadeia sem buracos', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [openingEntry!];

    entries.push(move(wallet, 'debit', brl('30.00')));
    entries.push(move(wallet, 'credit', brl('50.00')));
    entries.push(move(wallet, 'debit', brl('120.00'))); // zera
    entries.push(move(wallet, 'credit', brl('0.01')));
    entries.push(move(wallet, 'credit', brl('999.99')));
    entries.push(move(wallet, 'debit', brl('500.00')));

    // invariante do enunciado: wallet.balance == saldo reconstruído pelo ledger
    expect(replay(entries).equals(wallet.balance)).toBe(true);

    // versões consecutivas, 1..n, e a última é a versão da wallet
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(wallet.version).toBe(7);

    // cada lançamento começa onde o anterior terminou
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter),
      ).toBe(true);
    }
    expect(entries.every((e) => e.isBalanced())).toBe(true);
  });
});

// ======================================================= critério 2: nunca negativo

describe('o saldo nunca fica negativo', () => {
  test('débito maior que o saldo é rejeitado e não altera nada', () => {
    const { wallet } = openWallet('50.00');
    const before = snapshot(wallet);

    expect(() => move(wallet, 'debit', brl('50.01'))).toThrow(
      InsufficientFundsError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test('a rejeição é um DomainError com code INSUFFICIENT_FUNDS', () => {
    const { wallet } = openWallet('10.00');
    try {
      move(wallet, 'debit', brl('20.00'));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  test('débito do saldo exato zera a wallet', () => {
    const { wallet } = openWallet('50.00');
    move(wallet, 'debit', brl('50.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('wallet com saldo zero não aceita nem um centavo de débito', () => {
    const { wallet } = openWallet('0.00');
    expect(() => move(wallet, 'debit', brl('0.01'))).toThrow(
      InsufficientFundsError,
    );
  });

  test('canDebit responde sem alterar a wallet', () => {
    const { wallet } = openWallet('50.00');
    const before = snapshot(wallet);
    expect(wallet.canDebit(brl('50.00'))).toBe(true);
    expect(wallet.canDebit(brl('50.01'))).toBe(false);
    expect(snapshot(wallet)).toEqual(before);
  });

  test('cenário do enunciado em sequência: 100.00, duas apostas de 80.00', () => {
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

// ================================================ critério 3: version só com mudança de saldo

describe('version só incrementa quando o saldo muda', () => {
  test('cada movimento bem-sucedido incrementa exatamente 1', () => {
    const { wallet } = openWallet('100.00');
    move(wallet, 'debit', brl('10.00'));
    expect(wallet.version).toBe(2);
    move(wallet, 'credit', brl('10.00'));
    expect(wallet.version).toBe(3);
  });

  test.each([
    ['saldo insuficiente', () => brl('1000.00'), 'debit' as const],
    ['moeda diferente no débito', () => usd('1.00'), 'debit' as const],
    ['moeda diferente no crédito', () => usd('1.00'), 'credit' as const],
    ['valor zero no débito', () => brl('0.00'), 'debit' as const],
    ['valor zero no crédito', () => brl('0.00'), 'credit' as const],
  ])(
    'operação recusada (%s) não altera version, saldo nem data',
    (_, money, operation) => {
      const { wallet } = openWallet('100.00');
      const before = snapshot(wallet);
      expect(() => move(wallet, operation, money())).toThrow();
      expect(snapshot(wallet)).toEqual(before);
    },
  );

  test('consultas não alteram version', () => {
    const { wallet } = openWallet('100.00');
    wallet.canDebit(brl('10.00'));
    void wallet.balance;
    expect(wallet.version).toBe(1);
  });
});

// ================================================================ erros

describe('tipos de erro', () => {
  test('moeda diferente é erro de negócio (CURRENCY_MISMATCH)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => move(wallet, 'credit', usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('movimento de valor zero é bug, não rejeição de negócio', () => {
    const { wallet } = openWallet('100.00');
    expect(() => move(wallet, 'credit', brl('0.00'))).toThrow(
      InvariantViolationError,
    );
  });
});

// ================================================================ rehydrate

describe('Wallet.rehydrate', () => {
  test('restaura o estado sem revalidar e continua a numeração de versões', () => {
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
