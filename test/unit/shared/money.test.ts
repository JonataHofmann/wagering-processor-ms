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

describe('Money.from: entradas válidas', () => {
  test.each([
    ['25.00', '25.00'],
    ['0.00', '0.00'],
    ['0', '0.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('aceita %p e normaliza para %p', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test('mantém a moeda', () => {
    expect(usd('1.00').currency).toBe('USD');
  });
});

describe('Money.from: entradas inválidas', () => {
  test.each([
    ['vazio', ''],
    ['só espaço', ' '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica maiúscula', '1E3'],
    ['notação científica com casas', '2.5e1'],
    ['3 casas decimais', '10.005'],
    ['4 casas decimais', '0.0001'],
    ['negativo', '-1.00'],
    ['negativo zero', '-0.00'],
    ['sinal positivo', '+1.00'],
    ['sem parte inteira', '.50'],
    ['ponto sem casas', '5.'],
    ['zero à esquerda', '01.00'],
    ['vírgula decimal', '1,00'],
    ['separador de milhar', '1,000.00'],
    ['espaço à esquerda', ' 1.00'],
    ['espaço à direita', '1.00 '],
    ['texto', 'abc'],
    ['hexadecimal', '0x10'],
    ['19 dígitos inteiros', '1000000000000000000.00'],
  ])('rejeita %s (%p)', (_, input) => {
    expect(domainErrorCode(() => brl(input))).toBe('INVALID_AMOUNT');
  });

  test.each([
    ['number', 25],
    ['null', null],
    ['undefined', undefined],
    ['objeto', { value: '1.00' }],
  ])('rejeita amount do tipo %s', (_, input) => {
    const props = { amount: input as unknown as string, currency: 'BRL' };
    expect(domainErrorCode(() => Money.from(props))).toBe('INVALID_AMOUNT');
  });

  test.each(['', 'brl', 'Brl', 'BR', 'BRLX', '123', 'R$'])(
    'rejeita moeda %p',
    (currency) => {
      expect(
        domainErrorCode(() => Money.from({ amount: '1.00', currency })),
      ).toBe('INVALID_CURRENCY');
    },
  );

  test('o erro é um DomainError com code estável', () => {
    try {
      brl('abc');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidMoneyError).code).toBe('INVALID_AMOUNT');
      expect((error as Error).name).toBe('InvalidMoneyError');
    }
  });
});

describe('aritmética sem arredondamento', () => {
  test('0.10 + 0.20 é exatamente 0.30 (em float seria 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('soma 0.01 mil vezes sem acumular erro', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('valores grandes mantêm os centavos', () => {
    expect(brl('999999999999999998.99').add(brl('1.00')).amount).toBe(
      '999999999999999999.99',
    );
  });

  test('subtract pode ficar negativo (para checar saldo insuficiente)', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.amount).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
  });

  test('negate inverte o sinal', () => {
    expect(brl('25.00').negate().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().amount).toBe('25.00');
  });

  test('negate de zero continua 0.00, nunca -0.00', () => {
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().amount).toBe('0.00');
  });
});

describe('imutabilidade', () => {
  test('operações devolvem nova instância e não alteram a original', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.amount).toBe('10.00');
    expect(sum.amount).toBe('15.00');
  });

  test('a instância é congelada em tempo de execução', () => {
    const money = brl('10.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });
});

describe('consultas', () => {
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

  test('equals compara valor e moeda, ignorando a forma de entrada', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s entre moedas diferentes lança CURRENCY_MISMATCH', (_, operation) => {
    expect(domainErrorCode(() => operation(brl('1.00'), usd('1.00')))).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  test('o erro é um CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes não lança, só devolve false', () => {
    expect(() => brl('1.00').equals(usd('1.00'))).not.toThrow();
  });
});

describe('serialização', () => {
  test('toJSON devolve MoneyProps com escala fixa', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  test('JSON.stringify produz o formato do contrato', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  test('toString é legível para logs', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  test('ida e volta pelo contrato preserva o valor', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
