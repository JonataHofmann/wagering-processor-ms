export interface RelayConfig {
  /** eventos por rodada */
  batchSize: number;
  /** reserva do lote; maior que o tempo de uma publicação */
  leaseMs: number;
  /** espera entre rodadas quando não há eventos pendentes */
  idleIntervalMs: number;
}

export const RELAY_CONFIG = Symbol('RelayConfig');

export function relayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RelayConfig {
  return {
    batchSize: Number(env.OUTBOX_BATCH_SIZE ?? 10),
    leaseMs: Number(env.OUTBOX_LEASE_MS ?? 30_000),
    idleIntervalMs: Number(env.OUTBOX_IDLE_INTERVAL_MS ?? 500),
  };
}
