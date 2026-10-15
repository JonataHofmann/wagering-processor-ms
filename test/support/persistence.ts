import {
  MikroTransactionManager,
  type TransactionTimeouts,
} from '@/src/infrastructure/persistence/mikro-transaction-manager';
import {
  type IsolatedDatabase,
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

/**
 * Creates an isolated database and connects the persistence layer to it.
 * The database belongs to this persistence instance: close() closes the ORM and drops the database.
 */
export async function createPersistence(timeouts?: TransactionTimeouts) {
  const db = await createIsolatedDatabase();
  return buildPersistence(db, { ownsDatabase: true, timeouts });
}

/**
 * Connects the persistence layer to an isolated database that already exists
 * (e.g. the same database used by the application in an HTTP test).
 * The database does NOT belong to this persistence instance: close() only closes the ORM;
 * whoever created the database is responsible for dropping it.
 */
export async function connectPersistence(
  db: IsolatedDatabase,
  timeouts?: TransactionTimeouts,
) {
  return buildPersistence(db, { ownsDatabase: false, timeouts });
}

/** Isolated database + MikroORM connected as wagering_app + all the real repositories. */
async function buildPersistence(
  db: IsolatedDatabase,
  options: { ownsDatabase: boolean; timeouts?: TransactionTimeouts },
) {
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
    tm: new MikroTransactionManager(orm, context, options.timeouts),
    wallets: new MikroWalletRepository(context),
    ledger: new MikroLedgerRepository(context),
    transactions: new MikroWagerTransactionRepository(context, clock),
    inbox: new MikroInboxRepository(context),
    outbox: new MikroOutboxRepository(context),
    async close(): Promise<void> {
      await orm.close(true);
      if (options.ownsDatabase) {
        await db.drop();
      }
    },
  };
}

export type Persistence = Awaited<ReturnType<typeof buildPersistence>>;
