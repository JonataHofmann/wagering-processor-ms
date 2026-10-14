import { DomainError } from '@/src/shared/error/domain-error';

export interface FieldViolation {
  field: string;
  message: string;
}

/** Entrada inválida (corpo, parâmetro, cursor). Vira HTTP 400 com os detalhes por campo. */
export class RequestValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';

  constructor(public readonly violations: readonly FieldViolation[]) {
    super(
      `invalid request: ${violations.map((v) => `${v.field} ${v.message}`).join('; ')}`,
    );
  }
}

/** Recurso inexistente. O code identifica o recurso (ex.: WALLET_NOT_FOUND). Vira HTTP 404. */
export class ResourceNotFoundError extends DomainError {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
