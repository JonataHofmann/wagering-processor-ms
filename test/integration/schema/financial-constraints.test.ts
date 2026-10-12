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
  test('no máximo uma wallet por player + moeda', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      app.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '0.00', 1)`,
        [crypto.randomUUID(), w.playerId],
      ),
    );
    expect(code).toBe('23505');
  });

  test('saldo negativo é barrado mesmo com bug na aplicação', async () => {
    const w = await openWallet(app, '100.00');
    expect(
      await sqlState(applyMovement(app, w, { kind: 'BET', amount: '150.00' })),
    ).toBe('23514');
  });

  test('valor com 3 casas decimais é rejeitado, não arredondado', async () => {
    const code = await sqlState(
      app.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '10.005', 1)`,
        [crypto.randomUUID(), crypto.randomUUID()],
      ),
    );
    expect(code).toBe('23514');
  });

  test('moeda precisa ser ISO-4217 em maiúsculas', async () => {
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
  test('idempotency key duplicada é barrada', async () => {
    const w = await openWallet(app, '0.00');
    const first = await insertTransaction(app, w);
    const code = await sqlState(
      insertTransaction(app, w, {
        idempotency_key: `provider-a:${first.externalId}`,
      }),
    );
    expect(code).toBe('23505');
  });

  test('o mesmo id externo do mesmo provedor é barrado, mesmo com outra key', async () => {
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

  test('REFUND e ROLLBACK exigem referência', async () => {
    const w = await openWallet(app, '0.00');
    expect(await sqlState(insertTransaction(app, w, { kind: 'REFUND' }))).toBe(
      '23514',
    );
    expect(
      await sqlState(insertTransaction(app, w, { kind: 'ROLLBACK' })),
    ).toBe('23514');
  });

  test('BET não pode ter referência', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      insertTransaction(app, w, {
        kind: 'BET',
        reference_external_transaction_id: 'qualquer',
      }),
    );
    expect(code).toBe('23514');
  });

  test('OPENING não pode ser submetido por um provedor', async () => {
    const w = await openWallet(app, '0.00');
    expect(await sqlState(insertTransaction(app, w, { kind: 'OPENING' }))).toBe(
      '23514',
    );
  });

  test('REJECTED exige failure_code', async () => {
    const w = await openWallet(app, '0.00');
    const code = await sqlState(
      insertTransaction(app, w, {
        status: 'REJECTED',
        balance_snapshot: '0.00',
      }),
    );
    expect(code).toBe('23514');
  });

  test('PENDING_REFERENCE exige agenda de reprocessamento', async () => {
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

  test('uma referência só pode ser revertida uma vez', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '10.00' });
    await applyMovement(app, w, { kind: 'REFUND', amount: '10.00', ref: bet });

    // nem um segundo REFUND, nem um ROLLBACK da mesma BET
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
   * Insere um lançamento para uma transação que ainda NÃO tem lançamento,
   * para que a única violação seja a que o teste quer provar.
   */
  async function insertEntry(values: {
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
  }): Promise<string | undefined> {
    const w = await openWallet(app, '100.00');
    const tx = await insertTransaction(app, w); // LOSS pendente: sem lançamento
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

  test('aritmética do lançamento é verificada', async () => {
    // 100 - 10 deveria ser 90, não 85
    expect(
      await insertEntry({
        currency: 'BRL',
        balanceBefore: '100.00',
        balanceAfter: '85.00',
      }),
    ).toBe('23514');
  });

  test('moeda do lançamento precisa ser a da wallet', async () => {
    // aritmética correta, só a moeda está errada
    expect(
      await insertEntry({
        currency: 'USD',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      }),
    ).toBe('23503');
  });
});
