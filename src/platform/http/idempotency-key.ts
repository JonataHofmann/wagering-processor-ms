import { RequestValidationError } from '@/src/shared/error/application-errors';
import { isString, maxLength } from 'class-validator';

const FIELD = 'idempotency-key';
const MAX_LENGTH = 255;

/**
 * Headers não passam pelo sistema de Pipes do Nest (RouteParamtypes.HEADERS não é
 * "pipeable" em router-execution-context.js), então o ValidationPipe global nunca
 * roda sobre um DTO de header — por isso validamos manualmente aqui, reaproveitando
 * os validators do class-validator em vez de checar string na unha.
 */
export function requireIdempotencyKey(
  idempotencyKey: string | undefined,
): string {
  if (!isString(idempotencyKey) || !maxLength(idempotencyKey, MAX_LENGTH)) {
    throw new RequestValidationError([
      {
        field: FIELD,
        message: `must be a string with at most ${MAX_LENGTH} characters`,
      },
    ]);
  }
  return idempotencyKey;
}
