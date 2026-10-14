import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export function assertIdentifier(
  name: string,
  value: string,
  maxLength: number,
): void {
  if (value.trim() === '' || value.length > maxLength) {
    throw new InvariantViolationError(
      `${name} must be non-empty and at most ${maxLength} chars, got "${value}"`,
    );
  }
}
