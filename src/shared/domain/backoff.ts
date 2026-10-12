import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

/**
 * none:  espera exatamente o valor exponencial (determinístico; útil em testes).
 * equal: espera entre a metade e o valor exponencial. Espalha os retries de várias
 *        instâncias sem nunca cair para zero (o "full jitter" pode sortear 0 e martelar o serviço).
 */
export type JitterStrategy = 'none' | 'equal';

export interface ExponentialBackoffOptions {
  /** espera da primeira tentativa, em ms */
  baseMs: number;
  /** teto: nenhuma espera passa disto, em ms */
  maxMs: number;
  /** padrão: 'equal' */
  jitter?: JitterStrategy;
  /** fonte de aleatoriedade em [0, 1); padrão Math.random. Injetável para testes. */
  random?: () => number;
}

export class ExponentialBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter: JitterStrategy;
  private readonly random: () => number;

  constructor(options: ExponentialBackoffOptions) {
    if (!Number.isInteger(options.baseMs) || options.baseMs <= 0) {
      throw new InvariantViolationError(
        `baseMs must be a positive integer, got ${options.baseMs}`,
      );
    }
    if (!Number.isInteger(options.maxMs) || options.maxMs < options.baseMs) {
      throw new InvariantViolationError(
        `maxMs must be an integer >= baseMs, got ${options.maxMs}`,
      );
    }
    this.baseMs = options.baseMs;
    this.maxMs = options.maxMs;
    this.jitter = options.jitter ?? 'equal';
    this.random = options.random ?? Math.random;
  }

  /** Valor exponencial limitado ao teto, sem jitter. `attempt` começa em 1. */
  ceilingFor(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new InvariantViolationError(
        `attempt must be an integer >= 1, got ${attempt}`,
      );
    }
    // para tentativas muito altas, 2 ** n vira Infinity; o Math.min devolve o teto
    return Math.min(this.maxMs, this.baseMs * 2 ** (attempt - 1));
  }

  /** Espera em ms antes da tentativa `attempt` (inteiro, sempre entre ceiling/2 e ceiling). */
  delayFor(attempt: number): number {
    const ceiling = this.ceilingFor(attempt);
    if (this.jitter === 'none') return ceiling;

    const half = Math.floor(ceiling / 2);
    const r = Math.min(Math.max(this.random(), 0), 0.999_999_999); // protege contra random() fora de [0, 1)
    return half + Math.floor(r * (ceiling - half + 1));
  }
}
