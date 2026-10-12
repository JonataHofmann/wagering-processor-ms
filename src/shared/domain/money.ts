import { SCALE } from '@/src/shared/contants/money.contants';
import { CurrencyMismatchError } from '@/src/shared/error/currency-mismatch-error';
import { assertAmount } from '@/src/shared/util/assert-amount';
import { assertCurrency } from '@/src/shared/util/assert-currency';
import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

const Dec = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  private static of(value: Decimal, currency: string): Money {
    return new Money(value.isZero() ? new Dec(0) : value, currency);
  }

  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    const currency: unknown = props?.currency;
    assertAmount(amount);
    assertCurrency(currency);
    return Money.of(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return Money.of(new Dec(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
