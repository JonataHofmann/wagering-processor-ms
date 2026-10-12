import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { inTx, sqlState } from '@/test/support/pg';
import {
  applyMovement,
  insertTransaction,
  openWallet,
  readWallet,
} from '@/test/support/schema-fixtures';

let db: IsolatedDatabase;
let app: Pool;
let owner: Pool;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  app = new Pool({ connectionString: db.appUrl });
  owner = new Pool({ connectionString: db.ownerUrl });
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

describe('caminho correto é aceito', () => {
  test('abrir, apostar e fazer rollback da aposta', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '30.00' });
    expect(await readWallet(app, w.walletId)).toEqual({
      balance: '70.00',
      version: 2,
    });

    await applyMovement(app, w, {
      kind: 'ROLLBACK',
      amount: '30.00',
      ref: bet,
      direction: 'CREDIT',
    });
    expect(await readWallet(app, w.walletId)).toEqual({
      balance: '100.00',
      version: 3,
    });
  });

  test('LOSS processado sem lançamento é aceito', async () => {
    const w = await openWallet(app, '100.00');
    await insertTransaction(app, w, {
      kind: 'LOSS',
      status: 'PROCESSED',
      balance_snapshot: '100.00',
      processed_at: new Date(),
    });
    expect(await readWallet(app, w.walletId)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });
});

describe('ledger append-only (WL001)', () => {
  test('nem o owner altera, apaga ou trunca o ledger', async () => {
    await openWallet(app, '100.00');
    expect(
      await sqlState(
        owner.query(`UPDATE wallet_ledger_entries SET amount = '1.00'`),
      ),
    ).toBe('WL001');
    expect(
      await sqlState(owner.query(`DELETE FROM wallet_ledger_entries`)),
    ).toBe('WL001');
    expect(
      await sqlState(owner.query(`TRUNCATE wallet_ledger_entries CASCADE`)),
    ).toBe('WL001');
  });
});

describe('saldo ⇔ ledger ⇔ transação (WL002, no COMMIT)', () => {
  test('wallet aberta com saldo exige lançamento OPENING', async () => {
    const code = await sqlState(
      inTx(app, (c) =>
        c.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', '10.00', 1)`,
          [crypto.randomUUID(), crypto.randomUUID()],
        ),
      ),
    );
    expect(code).toBe('WL002');
  });

  test('saldo não muda sem lançamento correspondente', async () => {
    const w = await openWallet(app, '100.00');
    const code = await sqlState(
      inTx(app, (c) =>
        c.query(
          `UPDATE wallets SET balance = '50.00', version = 2 WHERE id = $1`,
          [w.walletId],
        ),
      ),
    );
    expect(code).toBe('WL002');
  });

  test('versão não sobe sem mudança de saldo', async () => {
    const w = await openWallet(app, '100.00');
    const code = await sqlState(
      inTx(app, (c) =>
        c.query(`UPDATE wallets SET version = version + 1 WHERE id = $1`, [
          w.walletId,
        ]),
      ),
    );
    expect(code).toBe('WL002');
  });

  test('ROLLBACK de BET precisa creditar, não debitar', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '10.00' });
    const code = await sqlState(
      applyMovement(app, w, {
        kind: 'ROLLBACK',
        amount: '10.00',
        ref: bet,
        direction: 'DEBIT',
      }),
    );
    expect(code).toBe('WL002');
  });

  test('LOSS não pode gerar lançamento', async () => {
    const w = await openWallet(app, '100.00');
    expect(
      await sqlState(applyMovement(app, w, { kind: 'LOSS', amount: '5.00' })),
    ).toBe('WL002');
  });

  test('uma operação recusada no COMMIT não deixa nada gravado', async () => {
    const w = await openWallet(app, '100.00');
    await sqlState(applyMovement(app, w, { kind: 'LOSS', amount: '5.00' }));
    expect(await readWallet(app, w.walletId)).toEqual({
      balance: '100.00',
      version: 1,
    });
  });
});

describe('ciclo de vida da transação (WL003)', () => {
  test('estado terminal não muda', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '10.00' });
    const code = await sqlState(
      app.query(
        `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = $1`,
        [bet.txId],
      ),
    );
    expect(code).toBe('WL003');
  });

  test('colunas de identidade não mudam, nem em transação pendente', async () => {
    const w = await openWallet(app, '0.00');
    const tx = await insertTransaction(app, w);
    const code = await sqlState(
      app.query(`UPDATE wager_transactions SET amount = '2.00' WHERE id = $1`, [
        tx.txId,
      ]),
    );
    expect(code).toBe('WL003');
  });

  test('PENDING_REFERENCE não volta para PENDING', async () => {
    const w = await openWallet(app, '0.00');
    const tx = await insertTransaction(app, w, {
      kind: 'REFUND',
      reference_external_transaction_id: 'ainda-nao-chegou',
      status: 'PENDING_REFERENCE',
      next_attempt_at: new Date(),
      expires_at: new Date(Date.now() + 15 * 60_000),
    });
    const code = await sqlState(
      app.query(
        `UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`,
        [tx.txId],
      ),
    );
    expect(code).toBe('WL003');
  });

  test('nem o owner apaga transações', async () => {
    const w = await openWallet(app, '100.00');
    const bet = await applyMovement(app, w, { kind: 'BET', amount: '10.00' });
    expect(
      await sqlState(
        owner.query(`DELETE FROM wager_transactions WHERE id = $1`, [bet.txId]),
      ),
    ).toBe('WL003');
  });
});

describe('campos imutáveis da wallet (WL004)', () => {
  test('moeda e jogador não mudam', async () => {
    const w = await openWallet(app, '0.00');
    expect(
      await sqlState(
        app.query(`UPDATE wallets SET currency = 'USD' WHERE id = $1`, [
          w.walletId,
        ]),
      ),
    ).toBe('WL004');
    expect(
      await sqlState(
        app.query(`UPDATE wallets SET player_id = $2 WHERE id = $1`, [
          w.walletId,
          crypto.randomUUID(),
        ]),
      ),
    ).toBe('WL004');
  });
});
