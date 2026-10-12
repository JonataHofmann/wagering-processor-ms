import {
  createEmptyDatabase,
  runMigrations,
  type IsolatedDatabase,
} from '@/test/support/database';
import { queryOnce } from '@/test/support/pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await createEmptyDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function listTables(): Promise<string[]> {
  const rows = await queryOnce<{ table_name: string }>(
    db.ownerUrl,
    `
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function countUserObjects(): Promise<{
  triggers: number;
  functions: number;
  domains: number;
}> {
  const [row] = await queryOnce<{
    triggers: string;
    functions: string;
    domains: string;
  }>(
    db.ownerUrl,
    `
    SELECT
      (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = 'public') AS triggers,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public') AS functions,
      (SELECT count(*) FROM information_schema.domains WHERE domain_schema = 'public') AS domains`,
  );
  return {
    triggers: Number(row?.triggers),
    functions: Number(row?.functions),
    domains: Number(row?.domains),
  };
}

test('migrations sobem, descem por completo e sobem de novo', async () => {
  await runMigrations(db.ownerUrl, 'up');
  expect(await listTables()).toEqual([
    'inbox_messages',
    'outbox_messages',
    'wager_transactions',
    'wallet_ledger_entries',
    'wallets',
  ]);

  await runMigrations(db.ownerUrl, 'down-all');
  expect(await listTables()).toEqual([]);
  // o down remove tudo o que o up criou, não só as tabelas
  expect(await countUserObjects()).toEqual({
    triggers: 0,
    functions: 0,
    domains: 0,
  });

  await runMigrations(db.ownerUrl, 'up');
  expect(await listTables()).toHaveLength(5);
});
