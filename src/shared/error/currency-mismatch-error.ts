import { DomainError } from '@/src/shared/error/domain-error';

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}
