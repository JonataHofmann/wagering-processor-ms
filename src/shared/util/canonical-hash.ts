import { CanonicalizationError } from '@/src/shared/error/canonicalization-error';
import { createHash } from 'node:crypto';

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };


function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `non-finite number cannot be canonicalized: ${value}`,
        );
      }
      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalizationError(
          `only plain objects can be canonicalized, got ${value.constructor?.name ?? 'unknown'}`,
        );
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
      return `{${members.join(',')}}`;
    }

    default:
      throw new CanonicalizationError(`unsupported type: ${typeof value}`);
  }
}

/** SHA-256 em hexadecimal minúsculo (64 caracteres), o formato aceito pelo banco. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** payloadHash = SHA-256(JCS(value)). */
export function canonicalHash(value: CanonicalValue): string {
  return sha256Hex(canonicalize(value));
}
