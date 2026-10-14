import { ExponentialBackoff } from '@/src/shared/domain/backoff';

/**
 * Política padrão de retry da publicação: 1 s, 2 s, 4 s... até 5 min, com equal jitter.
 * Sem limite de tentativas: evento confirmado não pode ser perdido.
 */
export const OUTBOX_RETRY_BACKOFF = new ExponentialBackoff({
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  jitter: 'equal',
});

export const MAX_ERROR_LENGTH = 500; // outbox_messages.last_error
