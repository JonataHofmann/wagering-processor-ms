import {
  LedgerEntryView,
  toLedgerEntryView,
} from '@/src/modules/wallet/application/wallet-view';

import { LedgerCursor } from '@/src/modules/wallet/application/ledger-cursor';
import { LedgerRepository } from '@/src/modules/wallet/application/ports/ledger.repository';
import { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import { ResourceNotFoundError } from '@/src/shared/application/application-errors';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';

export interface ListLedgerInput {
  walletId: string;
  cursor?: string;
  limit: number;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** null quando não há mais páginas */
  nextCursor: string | null;
}

export class ListLedgerQuery {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async execute(input: ListLedgerInput): Promise<LedgerPage> {
    const afterVersion =
      input.cursor === undefined
        ? undefined
        : LedgerCursor.decode(input.cursor);

    const entries = await this.transactionManager.runInTransaction(async () => {
      if ((await this.wallets.findById(input.walletId)) === undefined) {
        throw new ResourceNotFoundError(
          'WALLET_NOT_FOUND',
          `wallet ${input.walletId} not found`,
        );
      }
      // busca um a mais para saber se existe próxima página sem um COUNT
      return this.ledger.listByWallet({
        walletId: input.walletId,
        afterVersion,
        limit: input.limit + 1,
      });
    });

    const page = entries.slice(0, input.limit);
    const hasMore = entries.length > input.limit;
    const last = page.at(-1);

    return {
      items: page.map(toLedgerEntryView),
      nextCursor:
        hasMore && last ? LedgerCursor.encode(last.walletVersion) : null,
    };
  }
}
