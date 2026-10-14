import {
  FAILURE_CODES,
  FailureCode,
} from '@/src/modules/wagering/error/failure-code';

export function isFailureCode(value: string): value is FailureCode {
  return Object.hasOwn(FAILURE_CODES, value);
}
