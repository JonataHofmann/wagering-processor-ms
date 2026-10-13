import type { AppRole } from '@/src/config/app-roles';
import type { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import type {
  ResolutionOutcome,
  ResolvePendingReferenceUseCase,
} from '@/src/modules/wagering/application/resolve-pending-reference.use-case';
import { faultPoint } from '@/src/platform/testing/fault-injection';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { SchedulerConfig } from './scheduler.config';

/**
 * Reprocessa pendências de referência vencidas, nas instâncias com o papel "scheduler".
 * Cada rodada: reserva um lote (SKIP LOCKED + lease) e resolve cada pendência em paralelo.
 * Pendências da mesma wallet ficam serializadas pelo lock da wallet dentro do caso de uso.
 * Se uma resolução falhar (ou o processo morrer), a reserva vence e outra rodada tenta de novo.
 */
export class PendingReferenceScheduler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('PendingReferenceScheduler');
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
    private readonly transactions: WagerTransactionRepository,
    private readonly resolver: ResolvePendingReferenceUseCase,
    private readonly clock: Clock,
    private readonly config: SchedulerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.roles.has('scheduler')) return;
    this.loop = this.run();
    this.logger.log('resolving pending references');
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.loop === undefined) return;
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.logger.log('stopped');
  }

  /** Uma rodada: devolve quantas pendências foram reservadas. */
  async runOnce(): Promise<number> {
    const ids = await this.transactionManager.runInTransaction(() =>
      this.transactions.claimDuePendingReferences({
        now: this.clock.now(),
        leaseMs: this.config.leaseMs,
        limit: this.config.batchSize,
      }),
    );
    if (ids.length === 0) return 0;
    faultPoint('crash-after-claim-before-resolve'); // teste: reservadas, nenhuma resolvida

    const outcomes = await Promise.all(ids.map((id) => this.resolveOne(id)));
    const counts = outcomes.reduce<Record<string, number>>(
      (acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }),
      {},
    );
    this.logger.debug(`round: ${JSON.stringify(counts)}`);
    return ids.length;
  }

  private async resolveOne(id: string): Promise<ResolutionOutcome | 'failed'> {
    try {
      return await this.resolver.execute(id);
    } catch (error) {
      // a reserva vence em leaseMs e a pendência volta a ser tentada
      this.logger.warn(`could not resolve ${id}: ${(error as Error).message}`);
      return 'failed';
    }
  }

  private async run(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopping) {
      try {
        const claimed = await this.runOnce();
        consecutiveErrors = 0;
        if (claimed === this.config.batchSize) continue; // há mais vencidas
        await this.sleep(this.config.idleIntervalMs);
      } catch (error) {
        consecutiveErrors += 1;
        const delay = this.errorBackoff.delayFor(consecutiveErrors);
        this.logger.error(
          `scheduler round failed (${(error as Error).message}); retrying in ${delay} ms`,
        );
        await this.sleep(delay);
      }
    }
  }

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
