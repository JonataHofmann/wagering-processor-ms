import { AppRole } from '@/src/config/app-roles';
import { faultPoint } from '@/src/platform/testing/fault-injection';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { hostname } from 'node:os';

import { OutboxRelay } from '@/src/modules/messaging/application/use-cases/outbox-relay';
import { EventPublisher } from '@/src/modules/messaging/application/ports/event-publisher.port';
import { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { runWithLogContext } from '@/src/platform/observability/log-context';
import type { Metrics } from '@/src/platform/observability/metrics';
import type { RelayConfig } from './relay.config';

/**
 * Roda o OutboxRelay em loop nas instâncias com o papel "relay".
 * - lote cheio: próxima rodada imediata (há mais pendentes);
 * - lote vazio ou parcial: espera idleIntervalMs;
 * - erro (ex.: banco fora): espera com backoff e continua.
 * Para no beforeApplicationShutdown: termina a rodada em andamento antes de o pool fechar.
 */
export class OutboxRelayWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('OutboxRelay');
  private readonly errorBackoff = new ExponentialBackoff({
    baseMs: 500,
    maxMs: 30_000,
  });
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly roles: ReadonlySet<AppRole>,
    private readonly transactionManager: TransactionManager,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher | undefined,
    private readonly clock: Clock,
    private readonly config: RelayConfig,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.roles.has('relay')) return;
    if (this.publisher === undefined)
      throw new Error('the "relay" role requires SQS configuration');

    const owner = `${hostname()}:${process.pid}`;
    const relay = new OutboxRelay(
      this.transactionManager,
      this.outbox,
      this.publisher,
      this.clock,
      {
        owner,
        batchSize: this.config.batchSize,
        leaseMs: this.config.leaseMs,
        afterClaim: () => faultPoint('crash-after-claim-before-publish'),
        afterPublish: () => faultPoint('crash-after-publish-before-mark'),
        metrics: this.metrics,
      },
    );
    this.loop = this.run(relay);
    this.logger.log(`relaying outbox as ${owner}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.loop === undefined) return;
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.logger.log('stopped');
  }

  private async run(relay: OutboxRelay): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopping) {
      try {
        const round = await runWithLogContext({ job: 'outbox-relay' }, () =>
          relay.relayOnce(),
        );
        consecutiveErrors = 0;
        if (round.failed > 0)
          this.logger.warn({
            event: 'outbox_round_with_failures',
            job: 'outbox-relay',
            ...round,
          });
        consecutiveErrors = 0;
        if (round.failed > 0)
          this.logger.warn(
            `round: ${round.published} published, ${round.failed} failed`,
          );
        if (round.claimed === this.config.batchSize) continue; // há mais pendentes
        await this.sleep(this.config.idleIntervalMs);
      } catch (error) {
        consecutiveErrors += 1;
        const delay = this.errorBackoff.delayFor(consecutiveErrors);
        this.logger.error(
          `relay round failed (${(error as Error).message}); retrying in ${delay} ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  /** Espera interrompível pelo shutdown. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
