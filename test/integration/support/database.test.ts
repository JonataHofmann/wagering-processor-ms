import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../support/database';

async function query<T extends Record<string, unknown>>(
  url: string,
  sql: string,
): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe('createIsolatedDatabase', () => {
  let a: IsolatedDatabase;
  let b: IsolatedDatabase;

  beforeAll(async () => {
    a = await createIsolatedDatabase();
    b = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await a.drop();
    await b.drop();
  });

  test('creates an already-migrated database, accessible as the application', async () => {
    const [me] = await query<{ current_user: string }>(
      a.appUrl,
      'SELECT current_user',
    );
    expect(me?.current_user).toBe('wagering_app');

    const tables = await query<{ table_name: string }>(
      a.appUrl,
      `
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
       ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });

  test('each database is isolated from the others', async () => {
    await query(
      a.appUrl,
      `
      INSERT INTO wallets (id, player_id, currency, balance, version)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', '0.00', 1)`,
    );

    const [inA] = await query<{ n: string }>(
      a.appUrl,
      'SELECT count(*) AS n FROM wallets',
    );
    const [inB] = await query<{ n: string }>(
      b.appUrl,
      'SELECT count(*) AS n FROM wallets',
    );

    expect(inA?.n).toBe('1');
    expect(inB?.n).toBe('0');
  });

  test('the copy carries over the triggers and permissions from the template', async () => {
    const triggers = await query<{ n: string }>(
      a.ownerUrl,
      `SELECT count(DISTINCT trigger_name) AS n FROM information_schema.triggers`,
    );
    expect(Number(triggers[0]?.n)).toBeGreaterThan(0);

    const [perm] = await query<{ upd: boolean }>(
      a.ownerUrl,
      `SELECT has_table_privilege('wagering_app', 'wallet_ledger_entries', 'UPDATE') AS upd`,
    );
    expect(perm?.upd).toBe(false);
  });
});
