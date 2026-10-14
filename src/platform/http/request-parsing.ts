import {
  type FieldViolation,
  RequestValidationError,
} from '@/src/shared/error/application-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coleta violações campo a campo e lança um único RequestValidationError no fim,
 * para o cliente ver todos os problemas de uma vez.
 */
export class RequestParser {
  private readonly violations: FieldViolation[] = [];

  constructor(private readonly source: unknown) {}

  private value(field: string): unknown {
    if (typeof this.source !== 'object' || this.source === null)
      return undefined;
    return field
      .split('.')
      .reduce<unknown>(
        (node, key) =>
          typeof node === 'object' && node !== null
            ? (node as Record<string, unknown>)[key]
            : undefined,
        this.source,
      );
  }

  requireObject(field: string): void {
    const value = field === '' ? this.source : this.value(field);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.violations.push({
        field: field || 'body',
        message: 'must be an object',
      });
    }
  }

  string(
    field: string,
    options: { required?: boolean; maxLength?: number } = {},
  ): string | undefined {
    const value = this.value(field);
    if (value === undefined || value === null) {
      if (options.required ?? true)
        this.violations.push({ field, message: 'is required' });
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.violations.push({ field, message: 'must be a non-empty string' });
      return undefined;
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.violations.push({
        field,
        message: `must have at most ${options.maxLength} characters`,
      });
      return undefined;
    }
    return value;
  }

  uuid(field: string): string | undefined {
    const value = this.string(field);
    if (value !== undefined && !UUID.test(value)) {
      this.violations.push({ field, message: 'must be a UUID' });
      return undefined;
    }
    return value?.toLowerCase();
  }

  /** String que precisa ser um dos valores permitidos. */
  oneOf<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const value = this.string(field);
    if (
      value !== undefined &&
      !(allowed as readonly string[]).includes(value)
    ) {
      this.violations.push({
        field,
        message: `must be one of ${allowed.join(', ')}`,
      });
      return undefined;
    }
    return value as T | undefined;
  }
  /** Inteiro opcional vindo de query string. */
  integer(
    field: string,
    options: { min: number; max: number; default: number },
  ): number {
    const raw = this.value(field);
    if (raw === undefined || raw === '') return options.default;
    const value =
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (
      !Number.isInteger(value) ||
      value < options.min ||
      value > options.max
    ) {
      this.violations.push({
        field,
        message: `must be an integer between ${options.min} and ${options.max}`,
      });
      return options.default;
    }
    return value;
  }

  /** Lança se houve qualquer violação. Chame depois de ler todos os campos. */
  assertValid(): void {
    if (this.violations.length > 0)
      throw new RequestValidationError(this.violations);
  }
}

export function parseUuidParam(name: string, value: string): string {
  const parser = new RequestParser({ [name]: value });
  const parsed = parser.uuid(name);
  parser.assertValid();
  return parsed!;
}
