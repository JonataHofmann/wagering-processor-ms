import type {
  EventPublisher,
  PublishOutcome,
} from '@/src/modules/messaging/application/ports/event-publisher.port';

import type { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';

/**
 * Publicador em memória para testar a LÓGICA do relay (reserva, lease, retry) sobre o banco real.
 * A publicação de verdade no SQS é testada separadamente (parte 2).
 */
export class RecordingPublisher implements EventPublisher {
  /** cada publicação, na ordem em que aconteceu (duplicatas incluídas) */
  readonly published: Array<{
    id: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  /** ids que devem falhar na próxima publicação */
  failNext = new Set<string>();
  /** se definido, o publish inteiro lança (broker fora do ar) */
  outage: string | undefined;
  /** atraso artificial por chamada, para aumentar a chance de corridas */
  delayMs = 0;

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]> {
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    if (this.outage !== undefined) throw new Error(this.outage);
    return messages.map((message) => {
      if (this.failNext.delete(message.id))
        return { id: message.id, ok: false, error: 'simulated failure' };
      this.published.push({ id: message.id, payload: message.payload });
      return { id: message.id, ok: true };
    });
  }

  countOf(id: string): number {
    return this.published.filter((entry) => entry.id === id).length;
  }
}
