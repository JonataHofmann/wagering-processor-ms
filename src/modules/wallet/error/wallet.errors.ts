import { Money } from '@/src/shared/domain/money';
import { DomainError } from '@/src/shared/error/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: Money, requested: Money) {
    super(`insufficient funds: balance ${balance}, requested ${requested}`);
  }
}
