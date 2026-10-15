import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { sqlState } from '@/test/support/pg';
import { HASH } from '@/test/support/schema-fixtures';
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

function insertInbox(
  consumer: string,
  messageId: string,
  hash = HASH,
): Promise<unknown> {
  return app.query(
    `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ($1, $2, $3)`,
    [consumer, messageId, hash],
  );
}

function insertOutbox(
  overrides: { attempts?: number; eventVersion?: number } = {},
): Promise<unknown> {
  return app.query(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts)
     VALUES ($1, $2, 'WalletBalanceChanged', $3, '{}', now(), $4)`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      overrides.eventVersion ?? 1,
      overrides.attempts ?? 0,
    ],
  );
}

describe('inbox_messages', () => {
  test('the same message is not recorded twice by the same consumer', async () => {
    await insertInbox('wager-transactions', 'msg-dup');
    expect(await sqlState(insertInbox('wager-transactions', 'msg-dup'))).toBe(
      '23505',
    );
  });

  test('different consumers deduplicate independently', async () => {
    await insertInbox('wager-transactions', 'msg-shared');
    expect(await sqlState(insertInbox('audit', 'msg-shared'))).toBeUndefined();
  });

  test('ON CONFLICT DO NOTHING signals duplicate with zero rows, no error', async () => {
    await insertInbox('wager-transactions', 'msg-replay');
    const { rowCount } = await app.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
       VALUES ('wager-transactions', 'msg-replay', $1)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [HASH],
    );
    expect(rowCount).toBe(0);
  });

  test('payload_hash must be SHA-256 in hex', async () => {
    expect(
      await sqlState(
        insertInbox('wager-transactions', 'msg-bad-hash', 'nao-e-hash'),
      ),
    ).toBe('23514');
  });
});

describe('outbox_messages', () => {
  test('attempts cannot be negative', async () => {
    expect(await sqlState(insertOutbox({ attempts: -1 }))).toBe('23514');
  });

  test('event_version starts at 1', async () => {
    expect(await sqlState(insertOutbox({ eventVersion: 0 }))).toBe('23514');
  });

  test('a freshly written event is immediately available to the relay', async () => {
    const id = crypto.randomUUID();
    await app.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
       VALUES ($1, $2, 'WalletBalanceChanged', 1, '{}', now())`,
      [id, crypto.randomUUID()],
    );

    const { rows } = await app.query<{ id: string }>(
      `SELECT id FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= now() AND id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
  });
});
