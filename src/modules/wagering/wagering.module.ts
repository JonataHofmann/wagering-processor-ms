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
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from '../messaging/application/ports/inbox.repository';

import { APP_ROLES, type AppRole } from '@/src/config/app-roles';
import {
  SQS_CLIENT,
  SQS_CONFIG,
  type SqsConfig,
} from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { WagerMessageHandler } from './infrastructure/sqs/wager-message.handler';
import { WagerTransactionsConsumer } from './infrastructure/sqs/wager-transactions.consumer';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (
        transactionManager: TransactionManager,
        inbox: InboxRepository,
        wallets: WalletRepository,
        ledger: LedgerRepository,
        transactions: WagerTransactionRepository,
        outbox: OutboxRepository,
        ids: IdGenerator,
        clock: Clock,
      ) =>
        new ProcessWagerTransactionUseCase({
          transactionManager,
          inbox,
          wallets,
          ledger,
          transactions,
          outbox,
          ids,
          clock,
        }),
      inject: [
        TRANSACTION_MANAGER,
        INBOX_REPOSITORY,
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
    {
      provide: WagerMessageHandler,
      useFactory: (
        useCase: ProcessWagerTransactionUseCase,
        tm: TransactionManager,
        inbox: InboxRepository,
      ) => new WagerMessageHandler(useCase, tm, inbox),
      inject: [
        ProcessWagerTransactionUseCase,
        TRANSACTION_MANAGER,
        INBOX_REPOSITORY,
      ],
    },
    {
      provide: WagerTransactionsConsumer,
      useFactory: (
        roles: ReadonlySet<AppRole>,
        handler: WagerMessageHandler,
        client: SQSClient | undefined,
        config: SqsConfig | undefined,
      ) => new WagerTransactionsConsumer(roles, handler, client, config),
      inject: [
        APP_ROLES,
        WagerMessageHandler,
        { token: SQS_CLIENT, optional: true },
        { token: SQS_CONFIG, optional: true },
      ],
    },
  ],
  // exportado para o consumer SQS (etapa 14) reutilizar o mesmo caso de uso
  exports: [ProcessWagerTransactionUseCase, WagerMessageHandler],
})
export class WageringModule {}
