import { DomainError } from './domain-error';

export type InvalidMoneyCode = 'INVALID_AMOUNT' | 'INVALID_CURRENCY';

export class InvalidMoneyError extends DomainError {
  constructor(
    public readonly code: InvalidMoneyCode,
    message: string,
  ) {
    super(message);
  }
}
