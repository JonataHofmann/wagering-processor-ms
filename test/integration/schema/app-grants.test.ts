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

test('os testes conectam como a aplicação, não como owner', async () => {
  const [me] = await queryOnce<{ current_user: string }>(
    db.appUrl,
    'SELECT current_user',
  );
  expect(me?.current_user).toBe('wagering_app');
});

describe('o que a aplicação pode fazer', () => {
  test('ler e inserir nas tabelas operacionais', async () => {
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

  test('limpar eventos já publicados da outbox', async () => {
    expect(
      await sqlState(
        app.query(`DELETE FROM outbox_messages WHERE published_at IS NOT NULL`),
      ),
    ).toBeUndefined();
  });
});

describe('o que a aplicação não pode fazer (42501)', () => {
  const forbidden: Array<[string, string]> = [
    ['alterar o ledger', `UPDATE wallet_ledger_entries SET amount = '1.00'`],
    ['apagar o ledger', `DELETE FROM wallet_ledger_entries`],
    ['truncar o ledger', `TRUNCATE wallet_ledger_entries`],
    ['apagar wallets', `DELETE FROM wallets`],
    ['apagar transações', `DELETE FROM wager_transactions`],
    ['apagar a inbox', `DELETE FROM inbox_messages`],
    ['criar tabelas', `CREATE TABLE intrusa (id int)`],
    ['apagar tabelas', `DROP TABLE wallets`],
    ['ler a tabela de migrations', `SELECT count(*) FROM mikro_orm_migrations`],
  ];

  for (const [description, sql] of forbidden) {
    test(description, async () => {
      expect(await sqlState(app.query(sql))).toBe('42501');
    });
  }
});
