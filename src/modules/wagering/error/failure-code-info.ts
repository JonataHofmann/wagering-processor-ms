import {
  FAILURE_CODES,
  FailureCode,
  FailureCodeInfo,
} from '@/src/modules/wagering/error/failure-code';

export function failureCodeInfo(code: FailureCode): FailureCodeInfo {
  return FAILURE_CODES[code];
}
