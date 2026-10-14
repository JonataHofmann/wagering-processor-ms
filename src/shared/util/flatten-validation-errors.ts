import type { FieldViolation } from '@/src/shared/error/application-errors';
import type { ValidationError } from 'class-validator';

/** Achata a árvore de ValidationError do class-validator em violações por campo (dot-path). */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  prefix = '',
): FieldViolation[] {
  const violations: FieldViolation[] = [];
  for (const error of errors) {
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints !== undefined) {
      const [message] = Object.values(error.constraints);
      violations.push({ field, message: message ?? 'is invalid' });
    }
    if (error.children !== undefined && error.children.length > 0) {
      violations.push(...flattenValidationErrors(error.children, field));
    }
  }
  return violations;
}
