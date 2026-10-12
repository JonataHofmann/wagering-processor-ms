import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '@/src/modules/messaging/application/ports/outbox.repository';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { CLOCK, type Clock } from '@/src/shared/application/ports/clock.port';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '@/src/shared/application/ports/id-generator.port';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletQuery } from './application/get-wallet.query';
import { ListLedgerQuery } from './application/list-ledger.query';
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from './application/ports/ledger.repository';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from './application/ports/wallet.repository';
import { WalletsController } from './infrastructure/http/wallets.controller';

/**
 * Os casos de uso são classes puras (sem decorators do Nest).
 * O módulo os monta por factory, injetando as portas pelos tokens.
 */
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CreateWalletUseCase,
      useFactory: (
        transactionManager: TransactionManager,
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new CreateWalletUseCase({
          transactionManager,
          wallets,
          ledger,
          transactions,
          outbox,
          ids,
          clock,
        }),
      inject: [
        TRANSACTION_MANAGER,
        WALLET_REPOSITORY,
        LEDGER_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        OUTBOX_REPOSITORY,
        ID_GENERATOR,
        CLOCK,
      ],
    },
    {
      provide: GetWalletQuery,
      useFactory: (tm: TransactionManager, wallets: WalletRepository) =>
        new GetWalletQuery(tm, wallets),
      inject: [TRANSACTION_MANAGER, WALLET_REPOSITORY],
    },
    {
      provide: ListLedgerQuery,
      useFactory: (
        tm: TransactionManager,
        wallets: WalletRepository,
        ledger: LedgerRepository,
      ) => new ListLedgerQuery(tm, wallets, ledger),
      inject: [TRANSACTION_MANAGER, WALLET_REPOSITORY, LEDGER_REPOSITORY],
    },
  ],
})
export class WalletModule {}
