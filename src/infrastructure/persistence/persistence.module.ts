import { INBOX_REPOSITORY } from '@/src/modules/messaging/application/ports/inbox.repository';
import { OUTBOX_REPOSITORY } from '@/src/modules/messaging/application/ports/outbox.repository';
import { MikroInboxRepository } from '@/src/modules/messaging/infrastructure/persistence/mikro-inbox.repository';
import { MikroOutboxRepository } from '@/src/modules/messaging/infrastructure/persistence/mikro-outbox.repository';
import { WAGER_TRANSACTION_REPOSITORY } from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { MikroWagerTransactionRepository } from '@/src/modules/wagering/infrastructure/persistence/mikro-wager-transaction.repository';
import { LEDGER_REPOSITORY } from '@/src/modules/wallet/application/ports/ledger.repository';
import { WALLET_REPOSITORY } from '@/src/modules/wallet/application/ports/wallet.repository';
import { MikroLedgerRepository } from '@/src/modules/wallet/infrastructure/persistence/mikro-ledger.repository';
import { MikroWalletRepository } from '@/src/modules/wallet/infrastructure/persistence/mikro-wallet.repository';
import { CLOCK, type Clock } from '@/src/shared/application/ports/clock.port';
import { ID_GENERATOR } from '@/src/shared/application/ports/id-generator.port';
import { TRANSACTION_MANAGER } from '@/src/shared/application/ports/transaction-manager.port';
import { SystemClock } from '@/src/shared/infrastructure/system-clock';
import { UuidV7Generator } from '@/src/shared/infrastructure/uuid-v7.generator';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EntityManagerContext } from './entity-manager-context';
import { MikroTransactionManager } from './mikro-transaction-manager';
import config from '@/src/infrastructure/persistence/mikro-orm.config';

export interface PersistenceOptions {
  databaseUrl: string;
}

/** Fecha o pool de conexões no shutdown do Nest (SIGTERM ou app.close()). */
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

/**
 * Composição da infraestrutura: ORM, transação, relógio, ids e todos os repositórios.
 * Global: os módulos de negócio injetam as portas pelos tokens, sem importar este módulo.
 */
@Global()
@Module({})
export class PersistenceModule {
  static forRoot(options: PersistenceOptions): DynamicModule {
    const ctx = [EntityManagerContext];
    return {
      module: PersistenceModule,
      providers: [
        {
          provide: MikroORM,
          useFactory: () =>
            MikroORM.init({ ...config, clientUrl: options.databaseUrl }),
        },
        { provide: EntityManagerContext, useValue: new EntityManagerContext() },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        {
          provide: TRANSACTION_MANAGER,
          useFactory: (orm: MikroORM, context: EntityManagerContext) =>
            new MikroTransactionManager(orm, context),
          inject: [MikroORM, EntityManagerContext],
        },
        {
          provide: WALLET_REPOSITORY,
          useFactory: (c: EntityManagerContext) => new MikroWalletRepository(c),
          inject: ctx,
        },
        {
          provide: LEDGER_REPOSITORY,
          useFactory: (c: EntityManagerContext) => new MikroLedgerRepository(c),
          inject: ctx,
        },
        {
          provide: WAGER_TRANSACTION_REPOSITORY,
          useFactory: (c: EntityManagerContext, clock: Clock) =>
            new MikroWagerTransactionRepository(c, clock),
          inject: [EntityManagerContext, CLOCK],
        },
        {
          provide: INBOX_REPOSITORY,
          useFactory: (c: EntityManagerContext) => new MikroInboxRepository(c),
          inject: ctx,
        },
        {
          provide: OUTBOX_REPOSITORY,
          useFactory: (c: EntityManagerContext) => new MikroOutboxRepository(c),
          inject: ctx,
        },
        OrmShutdown,
      ],
      exports: [
        MikroORM,
        CLOCK,
        ID_GENERATOR,
        TRANSACTION_MANAGER,
        WALLET_REPOSITORY,
        LEDGER_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        INBOX_REPOSITORY,
        OUTBOX_REPOSITORY,
      ],
    };
  }
}
