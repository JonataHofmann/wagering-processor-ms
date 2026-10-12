import config from '@/src/infrastructure/persistence/mikro-orm.config';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';

const TEMPLATE = 'wagering_test_template';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} é obrigatória para testes de integração (confira o .env)`,
    );
  return value;
}

const ADMIN_URL = requireEnv('TEST_DATABASE_ADMIN_URL');
const APP_URL = requireEnv('TEST_DATABASE_APP_URL');

/** Troca só o nome do banco numa URL de conexão. */
function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Abre uma conexão administrativa, executa algo e fecha. */
async function asAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Roda as migrations num banco específico (sempre como owner). */
export async function runMigrations(
  databaseUrl: string,
  direction: 'up' | 'down-all' = 'up',
): Promise<void> {
  const orm = await MikroORM.init({
    ...config,
    clientUrl: databaseUrl,
    debug: false,
  });
  try {
    if (direction === 'up') await orm.migrator.up();
    else await orm.migrator.down({ to: 0 });
  } finally {
    // fecha todas as conexões: o Postgres não copia um template com conexões abertas
    await orm.close(true);
  }
}

let templateReady: Promise<void> | undefined;

/** Recria e migra o template uma única vez por execução de `bun test`. */
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
  /** nome do banco criado (wg_test_...) */
  readonly name: string;
  /** conexão como owner: ignora GRANTs, mas não ignora triggers */
  readonly ownerUrl: string;
  /** conexão como wagering_app: exatamente o que a aplicação usa */
  readonly appUrl: string;
  /** apaga o banco; chame no afterAll */
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

/** Banco já migrado, copiado do template. É o que quase todo teste usa. */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  await ensureTemplate();
  return create(TEMPLATE);
}

/** Banco vazio, sem migrations. Só para testar as próprias migrations. */
export function createEmptyDatabase(): Promise<IsolatedDatabase> {
  return create(undefined);
}
