import {
  OUTBOX_REPOSITORY,
  OutboxRepository,
} from '@/src/modules/messaging/application/ports/outbox.repository';
import {
  WAGER_TRANSACTION_REPOSITORY,
  WagerTransactionRepository,
} from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import {
  LEDGER_REPOSITORY,
  LedgerRepository,
} from '@/src/modules/wallet/application/ports/ledger.repository';
import {
  WALLET_REPOSITORY,
  WalletRepository,
} from '@/src/modules/wallet/application/ports/wallet.repository';
import { CLOCK, Clock } from '@/src/shared/application/ports/clock.port';
import {
  ID_GENERATOR,
  IdGenerator,
} from '@/src/shared/application/ports/id-generator.port';

import { GetTransactionQuery } from '@/src/modules/wagering/application/get-transaction.query';
import { ProcessWagerTransactionUseCase } from '@/src/modules/wagering/application/process-wager-transaction.use-case';
import { WageringController } from '@/src/modules/wagering/infrastructure/http/wagering.controller';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import { Module } from '@nestjs/common';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (
        transactionManager: TransactionManager,
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new ProcessWagerTransactionUseCase({
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
      provide: GetTransactionQuery,
      useFactory: (
        tm: TransactionManager,
        transactions: WagerTransactionRepository,
      ) => new GetTransactionQuery(tm, transactions),
      inject: [TRANSACTION_MANAGER, WAGER_TRANSACTION_REPOSITORY],
    },
  ],
  // exportado para o consumer SQS (etapa 14) reutilizar o mesmo caso de uso
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
