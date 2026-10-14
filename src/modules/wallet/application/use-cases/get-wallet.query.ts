import { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { ResourceNotFoundError } from '@/src/shared/error/application-errors';
import { toWalletView, type WalletView } from './wallet-view';

export class GetWalletQuery {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly wallets: WalletRepository,
  ) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.transactionManager.runInTransaction(() =>
      this.wallets.findById(walletId),
    );
    if (wallet === undefined) {
      throw new ResourceNotFoundError(
        'WALLET_NOT_FOUND',
        `wallet ${walletId} not found`,
      );
    }
    return toWalletView(wallet);
  }
}
