import { CURRENCY_PATTERN } from '@/src/shared/contants/money.contants';
import { InvalidMoneyError } from '@/src/shared/error/invalid-money-error';

export function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      'INVALID_CURRENCY',
      `invalid currency: ${JSON.stringify(currency)}`,
    );
  }
}
