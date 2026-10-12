import { ReferenceSchedule } from '@/src/modules/wagering/domain/wager-transaction';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';

/**
 * Espera por referências que chegam fora de ordem (ADR-011):
 * nova tentativa em 1 s, 2 s, 4 s... até 60 s; desiste após 15 minutos.
 */
export const REFERENCE_LOOKUP = {
  backoff: new ExponentialBackoff({
    baseMs: 1_000,
    maxMs: 60_000,
    jitter: 'equal',
  }),
  ttlMs: 15 * 60_000,

  firstSchedule(now: Date): ReferenceSchedule {
    return {
      nextAttemptAt: new Date(now.getTime() + this.backoff.delayFor(1)),
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };
  },
};
