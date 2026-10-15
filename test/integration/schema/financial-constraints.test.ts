import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { sqlState } from '@/test/support/pg';
import {
  applyMovement,
  insertTransaction,
  openWallet,
} from '@/test/support/schema-fixtures';
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

describe('wallets', () => {
  test('at most one wallet per player + currency', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      app.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '0.00', 1)`,
        [crypto.randomUUID(), w.playerId],
      ),
    );
    expect(code).toBe('23505');
  });

  test('negative balance is blocked even with a bug in the application', async () => {
    const w = await openWallet(app, '100.00');
    expect(
      await sqlState(applyMovement(app, w, { kind: 'BET', amount: '150.00' })),
    ).toBe('23514');
  });

  test('value with 3 decimal places is rejected, not rounded', async () => {
    const code = await sqlState(
      app.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '10.005', 1)`,
        [crypto.randomUUID(), crypto.randomUUID()],
      ),
    );
    expect(code).toBe('23514');
  });

  test('currency must be ISO-4217 uppercase', async () => {
    const code = await sqlState(
      app.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'brl', '0.00', 1)`,
        [crypto.randomUUID(), crypto.randomUUID()],
      ),
    );
    expect(code).toBe('23514');
  });
});

describe('wager_transactions', () => {
  test('duplicate idempotency key is blocked', async () => {
    const w = await openWallet(app, '0.00');
    const first = await insertTransaction(app, w);
    const code = await sqlState(
      insertTransaction(app, w, {
        idempotency_key: `provider-a:${first.externalId}`,
      }),
    );
    expect(code).toBe('23505');
  });

  test('the same external id from the same provider is blocked, even with a different key', async () => {
    const w = await openWallet(app, '0.00');
    const first = await insertTransaction(app, w);
    const code = await sqlState(
      insertTransaction(app, w, {
        external_transaction_id: first.externalId,
        idempotency_key: 'outra-key',
      }),
    );
    expect(code).toBe('23505');
  });

  test('REFUND and ROLLBACK require a reference', async () => {
    const w = await openWallet(app, '0.00');
    expect(await sqlState(insertTransaction(app, w, { kind: 'REFUND' }))).toBe(
      '23514',
    );
    expect(
      await sqlState(insertTransaction(app, w, { kind: 'ROLLBACK' })),
    ).toBe('23514');
  });

  test('BET cannot have a reference', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      insertTransaction(app, w, {
        kind: 'BET',
        reference_external_transaction_id: 'qualquer',
      }),
    );
    expect(code).toBe('23514');
  });

  test('OPENING cannot be submitted by a provider', async () => {
    const w = await openWallet(app, '0.00');
    expect(await sqlState(insertTransaction(app, w, { kind: 'OPENING' }))).toBe(
      '23514',
    );
  });

  test('REJECTED requires failure_code', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      insertTransaction(app, w, {
        status: 'REJECTED',
        balance_snapshot: '0.00',
      }),
    );
    expect(code).toBe('23514');
  });

  test('PENDING_REFERENCE requires a reprocessing schedule', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      insertTransaction(app, w, {
        kind: 'REFUND',
        reference_external_transaction_id: 'ainda-nao-chegou',
        status: 'PENDING_REFERENCE',
      }),
    );
    expect(code).toBe('23514');
  });

  test('a reference can only be reversed once', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '10.00' });
    await applyMovement(app, w, { kind: 'REFUND', amount: '10.00', ref: bet });

    // neither a second REFUND, nor a ROLLBACK of the same BET
    expect(
      await sqlState(
        applyMovement(app, w, { kind: 'REFUND', amount: '10.00', ref: bet }),
      ),
    ).toBe('23505');
    expect(
      await sqlState(
        applyMovement(app, w, {
          kind: 'ROLLBACK',
          amount: '10.00',
          ref: bet,
          direction: 'CREDIT',
        }),
      ),
    ).toBe('23505');
  });
});

describe('wallet_ledger_entries', () => {
  /**
   * Insert a ledger entry for a transaction that does NOT yet have an entry,
   * so that the only violation is the one the test wants to prove.
   */
  async function insertEntry(values: {
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
  }): Promise<string | undefined> {
    const w = await openWallet(app, '100.00');
    const tx = await insertTransaction(app, w); // pending LOSS: no entry
    return sqlState(
      app.query(
        `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 2, 'DEBIT', '10.00', $4, $5, $6)`,
        [
          crypto.randomUUID(),
          w.walletId,
          tx.txId,
          values.currency,
          values.balanceBefore,
          values.balanceAfter,
        ],
      ),
    );
  }

  test('ledger entry arithmetic is checked', async () => {
    // 100 - 10 should be 90, not 85
    expect(
      await insertEntry({
        currency: 'BRL',
        balanceBefore: '100.00',
        balanceAfter: '85.00',
      }),
    ).toBe('23514');
  });

  test('ledger entry currency must match the wallet currency', async () => {
    // correct arithmetic, only the currency is wrong
    expect(
      await insertEntry({
        currency: 'USD',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).toBe('23503');
  });
});
