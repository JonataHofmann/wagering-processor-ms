import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { IsolationLevel, type MikroORM } from '@mikro-orm/postgresql';

export interface TransactionTimeouts {
  /** quanto esperar por um lock de linha antes de desistir (vira erro transitório) */
  lockTimeoutMs: number;
  /** limite de qualquer comando dentro da transação */
  statementTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: TransactionTimeouts = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
};

export class MikroTransactionManager implements TransactionManager {
  constructor(
    private readonly orm: MikroORM,
    private readonly context: EntityManagerContext,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  /**
   * BEGIN (READ COMMITTED) → timeouts locais → work → COMMIT.
   * Qualquer erro em `work` ou no COMMIT (inclusive dos triggers deferidos) faz ROLLBACK e é relançado.
   */
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.isActive()) {
      throw new InvariantViolationError(
        'nested runInTransaction is not supported: one use case, one transaction',
      );
    }

    const em = this.orm.em.fork(); // EntityManager isolado: nada compartilhado entre requisições
    return em.transactional(
      async (tx) => {
        // set_config(..., true) equivale a SET LOCAL: vale só para esta transação
        await tx.execute(
          `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
          [
            `${this.timeouts.lockTimeoutMs}ms`,
            `${this.timeouts.statementTimeoutMs}ms`,
          ],
        );
        return this.context.run(tx, work);
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}
