import type { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import type { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { WagerTransactionProcessed } from '@/src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WalletBalanceChanged } from '@/src/modules/wagering/domain/events/wallet-balance-changed.event';
import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { LedgerRepository } from '@/src/modules/wallet/application/ports/ledger.repository';
import { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import {
  WalletView,
  toWalletView,
} from '@/src/modules/wallet/application/use-cases/wallet-view';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { IdGenerator } from '@/src/shared/application/ports/id-generator.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import type { EventContext } from '@/src/shared/domain/integration-event';
import { Money, type MoneyProps } from '@/src/shared/domain/money';
import { canonicalHash } from '@/src/shared/util/canonical-hash';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletDependencies {
  transactionManager: TransactionManager;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
}

/**
 * Abre a wallet. Com saldo inicial > 0, grava na MESMA transação SQL:
 * wallet (v1) + transação OPENING (PROCESSED) + lançamento CREDIT + 2 eventos na outbox.
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDependencies) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const { ids, clock } = this.deps;
    const initialBalance = Money.from(command.initialBalance); // InvalidMoneyError → 400
    const now = clock.now();

    const { wallet, openingEntry } = Wallet.open({
      id: ids.next(),
      playerId: command.playerId,
      initialBalance,
      openingTransactionId: ids.next(),
      openingEntryId: ids.next(),
      openedAt: now,
    });

    await this.deps.transactionManager.runInTransaction(async () => {
      await this.deps.wallets.insert(wallet); // WalletAlreadyExistsError → 409

      if (openingEntry === undefined) return; // saldo zero: sem movimento, sem lançamento, sem evento

      const opening = WagerTransaction.createOpening({
        id: openingEntry.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        payloadHash: canonicalHash({
          walletId: wallet.id,
          playerId: wallet.playerId,
          initialBalance: {
            amount: initialBalance.amount,
            currency: initialBalance.currency,
          },
        }),
        createdAt: now,
      });
      opening.markProcessed({ at: now, balanceSnapshot: wallet.balance });

      await this.deps.transactions.insert(opening);
      await this.deps.ledger.append(openingEntry);

      const context = (): EventContext => ({
        eventId: ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      });
      await this.deps.outbox.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opening, context()),
        ),
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, context()),
        ),
      ]);
    });

    return toWalletView(wallet);
  }
}
