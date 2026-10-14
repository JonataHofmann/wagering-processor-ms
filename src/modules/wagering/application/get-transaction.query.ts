import {
  TransactionView,
  toTransactionView,
} from '@/src/modules/wagering/application/transaction-view';

import { ResourceNotFoundError } from '@/src/shared/error/application-errors';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';
import { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';

export class GetTransactionQuery {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  byId(transactionId: string): Promise<TransactionView> {
    return this.find(
      () => this.transactions.findById(transactionId),
      `transaction ${transactionId}`,
    );
  }

  byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.find(
      () =>
        this.transactions.findByExternalId(providerId, externalTransactionId),
      `transaction ${providerId}/${externalTransactionId}`,
    );
  }

  private async find(
    lookup: () => Promise<WagerTransaction | undefined>,
    description: string,
  ): Promise<TransactionView> {
    const transaction = await this.transactionManager.runInTransaction(lookup);
    if (transaction === undefined) {
      throw new ResourceNotFoundError(
        'TRANSACTION_NOT_FOUND',
        `${description} not found`,
      );
    }
    return toTransactionView(transaction);
  }
}
