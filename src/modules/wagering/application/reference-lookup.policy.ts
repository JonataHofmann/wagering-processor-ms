import { ReferenceSchedule } from '@/src/modules/wagering/domain/wager-transaction';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';

export interface ReferenceLookupConfig {
  /** espera da primeira nova tentativa; dobra a cada tentativa */
  backoffBaseMs: number;
  /** teto do intervalo entre tentativas */
  backoffMaxMs: number;
  /** quanto tempo esperar pela referência antes de rejeitar com REFERENCE_NOT_FOUND */
  ttlMs: number;
}

export const REFERENCE_LOOKUP_POLICY = Symbol('ReferenceLookupPolicy');

export function referenceLookupConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReferenceLookupConfig {
  return {
    backoffBaseMs: Number(env.PENDING_REFERENCE_BACKOFF_BASE_MS ?? 1_000),
    backoffMaxMs: Number(env.PENDING_REFERENCE_BACKOFF_MAX_MS ?? 60_000),
    ttlMs: Number(env.PENDING_REFERENCE_TTL_MS ?? 15 * 60_000),
  };
}

/**
 * Espera por referências que chegam fora de ordem (ADR de referências):
 * novas tentativas em 1 s, 2 s, 4 s... até 60 s; desiste após 15 minutos.
 */
export class ReferenceLookupPolicy {
  private readonly backoff: ExponentialBackoff;

  constructor(readonly config: ReferenceLookupConfig) {
    this.backoff = new ExponentialBackoff({
      baseMs: config.backoffBaseMs,
      maxMs: config.backoffMaxMs,
      jitter: 'equal',
    });
  }

  /** Agenda da primeira espera (transação nova que não encontrou a referência). */
  firstSchedule(now: Date): ReferenceSchedule {
    return {
      nextAttemptAt: new Date(now.getTime() + this.backoff.delayFor(1)),
      expiresAt: new Date(now.getTime() + this.config.ttlMs),
    };
  }

  /** Próxima tentativa depois de `attemptsSoFar` tentativas sem sucesso. */
  nextAttemptAt(now: Date, attemptsSoFar: number): Date {
    return new Date(now.getTime() + this.backoff.delayFor(attemptsSoFar + 1));
  }
}
