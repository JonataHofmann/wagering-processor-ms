import {
  isLockConflict,
  isTransientDatabaseError,
  sqlStateOf,
} from '@/src/infrastructure/persistence/pg-error';
import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
import { RequestValidationError } from '@/src/shared/error/application-errors';
import { DomainError } from '@/src/shared/error/domain-error';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Logger,
} from '@nestjs/common';

/** Status HTTP por código de DomainError. O que não estiver aqui é rejeição de negócio: 422. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // payload ou parâmetro inválido
  VALIDATION_ERROR: 400,
  INVALID_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  OPENING_NOT_ALLOWED: 400,
  RESERVED_PROVIDER: 400,
  REFERENCE_REQUIRED: 400,
  REFERENCE_NOT_ALLOWED: 400,
  NON_POSITIVE_AMOUNT: 400,
  // recurso inexistente
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  // conflito
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  DUPLICATE_TRANSACTION: 409,
};

const UNPROCESSABLE = 422;
const SERVICE_UNAVAILABLE = 503;
const INTERNAL_ERROR = 500;
const RETRY_AFTER_SECONDS = '1';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * Traduz qualquer erro em uma resposta HTTP consistente para TODOS os endpoints:
 * 400 entrada inválida · 404 inexistente · 409 conflito · 422 regra de negócio ·
 * 503 falha transitória (pode reenviar) · 500 bug.
 */
@Catch()
export class ErrorMappingFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorMappingFilter.name);

  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body, retryAfter } = this.map(exception);
    if (retryAfter !== undefined) response.setHeader('Retry-After', retryAfter);
    response.status(status).json(body);
  }

  private map(exception: unknown): {
    status: number;
    body: ErrorBody;
    retryAfter?: string;
  } {
    if (exception instanceof RequestValidationError) {
      return {
        status: 400,
        body: {
          error: {
            code: exception.code,
            message: 'invalid request',
            details: exception.violations,
          },
        },
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: STATUS_BY_CODE[exception.code] ?? UNPROCESSABLE,
        body: { error: { code: exception.code, message: exception.message } },
      };
    }

    if (exception instanceof HttpException) {
      // erros do próprio Nest (rota inexistente, JSON malformado...)
      const status = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
            message: exception.message,
          },
        },
      };
    }

    if (isTransientDatabaseError(exception)) {
      if (isLockConflict(exception)) {
        this.metrics.increment('database_lock_conflicts_total', {
          sql_state: sqlStateOf(exception) ?? 'unknown',
        });
      }
      this.logger.warn(
        `transient database error: ${(exception as Error).message}`,
      );
      return {
        status: SERVICE_UNAVAILABLE,
        body: {
          error: {
            code: 'TEMPORARILY_UNAVAILABLE',
            message: 'temporary failure, retry with the same request',
          },
        },
        retryAfter: RETRY_AFTER_SECONDS,
      };
    }

    // InvariantViolationError, WL00x, erro inesperado: bug. Não vaza detalhes para o cliente.
    this.logger.error(
      `unexpected error: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      status: INTERNAL_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'internal error' } },
    };
  }
}
