import { describe, expect, test } from 'bun:test';

import { Money } from '@/src/shared/domain/money';
import { CurrencyMismatchError } from '@/src/shared/error/currency-mismatch-error';
import { DomainError } from '@/src/shared/error/domain-error';
import { InvalidMoneyError } from '@/src/shared/error/invalid-money-error';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

function domainErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
}

describe('Money.from: valid inputs', () => {
  test.each([
    ['25.00', '25.00'],
    ['0.00', '0.00'],
    ['0', '0.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and normalizes to %p', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test('keeps the currency', () => {
    expect(usd('1.00').currency).toBe('USD');
  });
});

describe('Money.from: invalid inputs', () => {
  test.each([
    ['empty', ''],
    ['only a space', ' '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['uppercase scientific notation', '1E3'],
    ['scientific notation with decimals', '2.5e1'],
    ['3 decimal places', '10.005'],
    ['4 decimal places', '0.0001'],
    ['negative', '-1.00'],
    ['negative zero', '-0.00'],
    ['positive sign', '+1.00'],
    ['no integer part', '.50'],
    ['point with no decimals', '5.'],
    ['leading zero', '01.00'],
    ['decimal comma', '1,00'],
    ['thousands separator', '1,000.00'],
    ['leading space', ' 1.00'],
    ['trailing space', '1.00 '],
    ['text', 'abc'],
    ['hexadecimal', '0x10'],
    ['19 integer digits', '1000000000000000000.00'],
  ])('rejects %s (%p)', (_, input) => {
    expect(domainErrorCode(() => brl(input))).toBe('INVALID_AMOUNT');
  });

  test.each([
    ['number', 25],
    ['null', null],
    ['undefined', undefined],
    ['object', { value: '1.00' }],
  ])('rejects amount of type %s', (_, input) => {
    const props = { amount: input as unknown as string, currency: 'BRL' };
    expect(domainErrorCode(() => Money.from(props))).toBe('INVALID_AMOUNT');
  });

  test.each(['', 'brl', 'Brl', 'BR', 'BRLX', '123', 'R$'])(
    'rejects currency %p',
    (currency) => {
      expect(
        domainErrorCode(() => Money.from({ amount: '1.00', currency })),
      ).toBe('INVALID_CURRENCY');
    },
  );

  test('the error is a DomainError with a stable code', () => {
    try {
      brl('abc');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidMoneyError).code).toBe('INVALID_AMOUNT');
      expect((error as Error).name).toBe('InvalidMoneyError');
    }
  });
});

describe('arithmetic without rounding', () => {
  test('0.10 + 0.20 is exactly 0.30 (in float it would be 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('adds 0.01 a thousand times without accumulating error', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('large values keep the cents', () => {
    expect(brl('999999999999999998.99').add(brl('1.00')).amount).toBe(
      '999999999999999999.99',
    );
  });

  test('subtract can go negative (to check insufficient balance)', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.amount).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
  });

  test('negate flips the sign', () => {
    expect(brl('25.00').negate().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().amount).toBe('25.00');
  });

  test('negate of zero stays 0.00, never -0.00', () => {
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().amount).toBe('0.00');
  });
});

describe('immutability', () => {
  test('operations return a new instance and do not change the original', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.amount).toBe('10.00');
    expect(sum.amount).toBe('15.00');
  });

  test('the instance is frozen at runtime', () => {
    const money = brl('10.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });
});

describe('queries', () => {
  test('isZero, isPositive, isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  test('isLessThan', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('20.00'))).toBe(false);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
  });

  test('equals compares value and currency, ignoring the input format', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('currency conflict', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s between different currencies throws CURRENCY_MISMATCH', (_, operation) => {
    expect(domainErrorCode(() => operation(brl('1.00'), usd('1.00')))).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  test('the error is a CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals between different currencies does not throw, it just returns false', () => {
    expect(() => brl('1.00').equals(usd('1.00'))).not.toThrow();
  });
});

describe('serialization', () => {
  test('toJSON returns MoneyProps with fixed scale', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  test('JSON.stringify produces the contract format', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  test('toString is readable for logs', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  test('round-tripping through the contract preserves the value', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
