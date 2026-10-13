import { DomainError } from '@/src/shared/error/domain-error';

/** Mesma Idempotency-Key com conteúdo diferente: conflito, nunca replay. HTTP 409. */
export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(idempotencyKey: string) {
    super(
      `idempotency key ${idempotencyKey} was already used with a different payload`,
    );
  }
}

export class DuplicateMessageError extends Error {
  constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
  ) {
    super(`message ${consumerName}/${messageId} already processed`);
    this.name = 'DuplicateMessageError';
  }
}
