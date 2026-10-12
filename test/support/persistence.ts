import {
  MikroTransactionManager,
  TransactionTimeouts,
} from '@/src/infrastructure/persistence/mikro-transaction-manager';
import {
  IsolatedDatabase,
  createIsolatedDatabase,
} from '@/test/support/database';

import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import config from '@/src/infrastructure/persistence/mikro-orm.config';
import { MikroInboxRepository } from '@/src/modules/messaging/infrastructure/persistence/mikro-inbox.repository';
import { MikroOutboxRepository } from '@/src/modules/messaging/infrastructure/persistence/mikro-outbox.repository';
import { MikroWagerTransactionRepository } from '@/src/modules/wagering/infrastructure/persistence/mikro-wager-transaction.repository';
import { MikroLedgerRepository } from '@/src/modules/wallet/infrastructure/persistence/mikro-ledger.repository';
import { MikroWalletRepository } from '@/src/modules/wallet/infrastructure/persistence/mikro-wallet.repository';
import { FixedClock } from '@/test/support/fakes';
import { MikroORM } from '@mikro-orm/postgresql';

/** Banco isolado + MikroORM conectado como wagering_app + todos os repositórios reais. */
export async function createPersistence(timeouts?: TransactionTimeouts) {
  const db: IsolatedDatabase = await createIsolatedDatabase();
  const orm = await MikroORM.init({
    ...config,
    clientUrl: db.appUrl,
    debug: false,
  });
  const context = new EntityManagerContext();
  const clock = new FixedClock();

  return {
    db,
    orm,
    clock,
    context,
    tm: new MikroTransactionManager(orm, context, timeouts),
    wallets: new MikroWalletRepository(context),
    ledger: new MikroLedgerRepository(context),
    transactions: new MikroWagerTransactionRepository(context, clock),
    inbox: new MikroInboxRepository(context),
    outbox: new MikroOutboxRepository(context),
    async close(): Promise<void> {
      await orm.close(true);
      await db.drop();
    },
  };
}

export type Persistence = Awaited<ReturnType<typeof createPersistence>>;
