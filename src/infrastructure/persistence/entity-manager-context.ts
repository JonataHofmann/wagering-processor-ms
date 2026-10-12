import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import type { EntityManager } from '@mikro-orm/postgresql';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Guarda o EntityManager da transação em andamento, por fluxo assíncrono.
 * Os repositórios pegam o EntityManager daqui: assim participam da mesma
 * transação sem que o caso de uso precise repassá-lo como parâmetro.
 */
export class EntityManagerContext {
  private readonly storage = new AsyncLocalStorage<EntityManager>();

  run<T>(em: EntityManager, work: () => Promise<T>): Promise<T> {
    return this.storage.run(em, work);
  }

  isActive(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** EntityManager da transação atual. Fora de uma transação é bug. */
  current(): EntityManager {
    const em = this.storage.getStore();
    if (em === undefined) {
      throw new InvariantViolationError(
        'repository used outside TransactionManager.runInTransaction()',
      );
    }
    return em;
  }
}
