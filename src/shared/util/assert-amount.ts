import { AMOUNT_PATTERN } from '@/src/shared/contants/money.contants';
import { InvalidMoneyError } from '@/src/shared/error/invalid-money-error';

export function assertAmount(amount: unknown): asserts amount is string {
  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
    throw new InvalidMoneyError(
      'INVALID_AMOUNT',
      `invalid amount: ${JSON.stringify(amount)}`,
    );
  }
}
