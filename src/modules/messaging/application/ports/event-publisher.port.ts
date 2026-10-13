import { OutboxMessage } from '@/src/modules/messaging/domain/outbox-message';

export type PublishOutcome =
  { id: string; ok: true } | { id: string; ok: false; error: string };

/**
 * Publica eventos da outbox no broker. Entrega at-least-once: a mesma mensagem pode
 * ser publicada mais de uma vez (ex.: processo morto entre publicar e marcar),
 * e o consumidor deduplica pelo eventId.
 */
export interface EventPublisher {
  /** Publica o lote; devolve o resultado de cada evento (falhas parciais são possíveis). */
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
