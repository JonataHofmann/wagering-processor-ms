export interface TransactionManager {
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_MANAGER = Symbol('TransactionManager');
