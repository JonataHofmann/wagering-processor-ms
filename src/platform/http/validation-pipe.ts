import { RequestValidationError } from '@/src/shared/error/application-errors';
import { flattenValidationErrors } from '@/src/shared/util/flatten-validation-errors';
import { ValidationPipe } from '@nestjs/common';

/**
 * ValidationPipe global: converte ValidationError[] do class-validator em
 * RequestValidationError, para o ErrorMappingFilter continuar mapeando para
 * 400 VALIDATION_ERROR sem precisar conhecer class-validator.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    exceptionFactory: (errors) =>
      new RequestValidationError(flattenValidationErrors(errors)),
  });
}
