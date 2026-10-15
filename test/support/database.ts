import config from '@/src/infrastructure/persistence/mikro-orm.config';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';

const TEMPLATE = 'wagering_test_template';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required for integration tests (check the .env)`,
    );
  return value;
}

const ADMIN_URL = requireEnv('TEST_DATABASE_ADMIN_URL');
const APP_URL = requireEnv('TEST_DATABASE_APP_URL');

/** Swaps only the database name in a connection URL. */
function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Opens an admin connection, runs something, and closes it. */
async function asAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Runs the migrations on a specific database (always as owner). */
export async function runMigrations(
  databaseUrl: string,
  direction: 'up' | 'down-all' = 'up',
): Promise<void> {
  const orm = await MikroORM.init({
    ...config,
    clientUrl: databaseUrl,
    debug: false,
    migrations: { ...config.migrations, silent: true },
  });
  try {
    if (direction === 'up') await orm.migrator.up();
    else await orm.migrator.down({ to: 0 });
  } finally {
    // closes all connections: Postgres won't copy a template that has open connections
    await orm.close(true);
  }
}

let templateReady: Promise<void> | undefined;

/** Recreates and migrates the template once per `bun test` run. */
function ensureTemplate(): Promise<void> {
  templateReady ??= (async () => {
    await asAdmin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${TEMPLATE}`);
    });
    await runMigrations(withDatabase(ADMIN_URL, TEMPLATE));
  })();
  return templateReady;
}

export interface IsolatedDatabase {
  /** name of the created database (wg_test_...) */
  readonly name: string;
  /** connection as owner: bypasses GRANTs, but not triggers */
  readonly ownerUrl: string;
  /** connection as wagering_app: exactly what the application uses */
  readonly appUrl: string;
  /** drops the database; call it in afterAll */
  drop(): Promise<void>;
}

async function create(template: string | undefined): Promise<IsolatedDatabase> {
  const name = `wg_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await asAdmin((c) =>
    c.query(
      template
        ? `CREATE DATABASE ${name} TEMPLATE ${template}`
        : `CREATE DATABASE ${name}`,
    ),
  );

  return {
    name,
    ownerUrl: withDatabase(ADMIN_URL, name),
    appUrl: withDatabase(APP_URL, name),
    drop: async () => {
      await asAdmin((c) =>
        c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      );
    },
  };
}

/** Already-migrated database, copied from the template. What almost every test uses. */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  await ensureTemplate();
  return create(TEMPLATE);
}

/** Empty database, no migrations. Only for testing the migrations themselves. */
export function createEmptyDatabase(): Promise<IsolatedDatabase> {
  return create(undefined);
}
