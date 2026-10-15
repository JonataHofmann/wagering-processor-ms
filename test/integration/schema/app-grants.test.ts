import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { queryOnce, sqlState } from '@/test/support/pg';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';

let db: IsolatedDatabase;
let app: Pool;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  app = new Pool({ connectionString: db.appUrl });
});

afterAll(async () => {
  await app.end();
  await db.drop();
});

test('tests connect as the application, not as owner', async () => {
  const [me] = await queryOnce<{ current_user: string }>(
    db.appUrl,
    'SELECT current_user',
  );
  expect(me?.current_user).toBe('wagering_app');
});

describe('what the application can do', () => {
  test('read and insert into operational tables', async () => {
    expect(
      await sqlState(app.query(`SELECT count(*) FROM wallets`)),
    ).toBeUndefined();
    expect(
      await sqlState(
        app.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '0.00', 1)`,
          [crypto.randomUUID(), crypto.randomUUID()],
        ),
      ),
    ).toBeUndefined();
  });

  test('clean up already-published events from the outbox', async () => {
    expect(
      await sqlState(
        app.query(`DELETE FROM outbox_messages WHERE published_at IS NOT NULL`),
      ),
    ).toBeUndefined();
  });
});

describe('what the application cannot do (42501)', () => {
  const forbidden: Array<[string, string]> = [
    ['alter the ledger', `UPDATE wallet_ledger_entries SET amount = '1.00'`],
    ['delete the ledger', `DELETE FROM wallet_ledger_entries`],
    ['truncate the ledger', `TRUNCATE wallet_ledger_entries`],
    ['delete wallets', `DELETE FROM wallets`],
    ['delete transactions', `DELETE FROM wager_transactions`],
    ['delete the inbox', `DELETE FROM inbox_messages`],
    ['create tables', `CREATE TABLE intrusa (id int)`],
    ['drop tables', `DROP TABLE wallets`],
    ['read the migrations table', `SELECT count(*) FROM mikro_orm_migrations`],
  ];

  for (const [description, sql] of forbidden) {
    test(description, async () => {
      expect(await sqlState(app.query(sql))).toBe('42501');
    });
  }
});
