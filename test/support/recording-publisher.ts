import type {
  EventPublisher,
  PublishOutcome,
} from '@/src/modules/messaging/application/ports/event-publisher.port';

import type { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';

/**
 * In-memory publisher to test the relay's LOGIC (reservation, lease, retry) against the real database.
 * The actual SQS publishing is tested separately (part 2).
 */
export class RecordingPublisher implements EventPublisher {
  /** each publication, in the order it happened (duplicates included) */
  readonly published: Array<{
    id: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  /** ids that should fail on the next publication */
  failNext = new Set<string>();
  /** if set, the whole publish throws (broker is down) */
  outage: string | undefined;
  /** artificial delay per call, to increase the chance of races */
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
