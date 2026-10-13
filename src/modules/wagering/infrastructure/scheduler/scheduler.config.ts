export interface SchedulerConfig {
  /** pendências reservadas por rodada */
  batchSize: number;
  /** reserva de cada pendência: se o scheduler morrer, outro a pega depois disso */
  leaseMs: number;
  /** espera entre rodadas quando não há pendências vencidas */
  idleIntervalMs: number;
}

export const SCHEDULER_CONFIG = Symbol('SchedulerConfig');

export function schedulerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SchedulerConfig {
  return {
    batchSize: Number(env.SCHEDULER_BATCH_SIZE ?? 20),
    leaseMs: Number(env.SCHEDULER_LEASE_MS ?? 10_000),
    idleIntervalMs: Number(env.SCHEDULER_IDLE_INTERVAL_MS ?? 500),
  };
}
