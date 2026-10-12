import { Money } from '@/src/shared/domain/money';
import { DomainError } from '@/src/shared/error/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: Money, requested: Money) {
    super(`insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}
