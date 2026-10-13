import {
  EventPublisher,
  PublishOutcome,
} from '@/src/modules/messaging/application/ports/event-publisher.port';

import { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import type { ExponentialBackoff } from '@/src/shared/domain/backoff';

export interface OutboxRelayOptions {
  /** identificação deste relay (instância), gravada em locked_by */
  owner: string;
  batchSize: number;
  /** tempo de reserva do lote; precisa ser maior que o tempo de uma publicação */
  leaseMs: number;
  /** backoff entre tentativas de publicação; padrão: o da OutboxMessage (1 s .. 5 min) */
  backoff?: ExponentialBackoff;
  /** gancho de teste: roda depois de reservar e antes de publicar */
  afterClaim?: () => void;
  /** gancho de teste: roda depois de publicar e antes de marcar como publicado */
  afterPublish?: () => void;
}

export interface RelayRound {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica os eventos da outbox. Cada rodada:
 *  1. reserva um lote (transação curta: UPDATE ... FOR UPDATE SKIP LOCKED, lease)
 *  2. publica FORA de transação (nenhuma conexão presa durante I/O de rede)
 *  3. marca os publicados e agenda os que falharam (transação curta)
 *
 * Se o processo morrer entre 2 e 3, o lease expira e outro relay publica de novo:
 * entrega at-least-once, deduplicada pelo consumidor via eventId.
 */
export class OutboxRelay {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: OutboxRelayOptions,
  ) {}

  async relayOnce(): Promise<RelayRound> {
    const claimed = await this.transactionManager.runInTransaction(() =>
      this.outbox.claimDue({
        now: this.clock.now(),
        leaseMs: this.options.leaseMs,
        limit: this.options.batchSize,
        owner: this.options.owner,
      }),
    );
    if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0 };
    this.options.afterClaim?.();

    let outcomes: PublishOutcome[];
    try {
      outcomes = await this.publisher.publish(claimed);
    } catch (error) {
      // broker fora do ar: o lote inteiro falhou e entra no backoff
      const reason = error instanceof Error ? error.message : String(error);
      outcomes = claimed.map((message) => ({
        id: message.id,
        ok: false,
        error: reason,
      }));
    }
    this.options.afterPublish?.();

    const byId = new Map(claimed.map((message) => [message.id, message]));
    const now = this.clock.now();
    let published = 0;
    let failed = 0;

    await this.transactionManager.runInTransaction(async () => {
      for (const outcome of outcomes) {
        const message = byId.get(outcome.id);
        if (message === undefined) continue;
        if (outcome.ok) {
          message.markPublished(now);
          await this.outbox.markPublished(message);
          published += 1;
        } else {
          message.scheduleRetry(now, {
            error: outcome.error,
            backoff: this.options.backoff,
          });
          await this.outbox.recordFailure(message);
          failed += 1;
        }
      }
    });

    return { claimed: claimed.length, published, failed };
  }
}
