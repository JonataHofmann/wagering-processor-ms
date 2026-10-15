import type { Pool } from 'pg';
import { inTx } from './pg';

export const HASH = 'a'.repeat(64);

export type Kind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Direction = 'DEBIT' | 'CREDIT';

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export interface TxRef {
  txId: string;
  externalId: string;
}

/** Anything with `.query`: a Pool or a client inside a transaction. */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

type ColumnValue = string | number | Date | null;

/**
 * Inserts a row into wager_transactions with valid default values.
 * `overrides` uses the column names (snake_case) and replaces any default.
 * Default: a LOSS of 1.00 BRL in PENDING, from provider-a.
 */
export async function insertTransaction(
  db: Queryable,
  wallet: TestWallet,
  overrides: Record<string, ColumnValue> = {},
): Promise<TxRef> {
  const id = String(overrides.id ?? crypto.randomUUID());
  const externalId = String(overrides.external_transaction_id ?? `ext-${id}`);

  const row: Record<string, ColumnValue> = {
    id,
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: wallet.walletId,
    player_id: wallet.playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'LOSS',
    amount: '1.00',
    currency: 'BRL',
    status: 'PENDING',
    ...overrides,
  };

  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  await db.query(
    `INSERT INTO wager_transactions (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(row),
  );

  return { txId: id, externalId: String(row.external_transaction_id) };
}

/** Opens a wallet the right way: with balance > 0, generates OPENING + a v1 CREDIT entry. */
export async function openWallet(
  pool: Pool,
  balance: string,
): Promise<TestWallet> {
  const wallet: TestWallet = {
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
  };

  await inTx(pool, async (c) => {
    await c.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES ($1, $2, 'BRL', $3, 1)`,
      [wallet.walletId, wallet.playerId, balance],
    );

    if (balance === '0.00') return; // no initial balance, no OPENING

    const opening = await insertTransaction(c, wallet, {
      provider_id: 'system',
      external_transaction_id: `opening-${wallet.walletId}`,
      idempotency_key: `opening:${wallet.walletId}`,
      round_id: 'opening',
      game_id: 'opening',
      kind: 'OPENING',
      amount: balance,
      status: 'PROCESSED',
      balance_snapshot: balance,
      processed_at: new Date(),
    });

    await c.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 1, 'CREDIT', $4, 'BRL', '0.00', $4)`,
      [crypto.randomUUID(), wallet.walletId, opening.txId, balance],
    );
  });

  return wallet;
}

export interface MovementOptions {
  kind: Exclude<Kind, 'OPENING'>;
  amount: string;
  /** default: DEBIT for BET, CREDIT for the rest. Specify explicitly for ROLLBACK. */
  direction?: Direction;
  ref?: TxRef;
}

/**
 * Applies a complete movement, the way the use case will:
 * updates the wallet, writes the PROCESSED transaction and the ledger entry, in a single transaction.
 * Does not validate business rules: its whole purpose is to prove that the DATABASE itself rejects what's invalid.
 */
export async function applyMovement(
  pool: Pool,
  wallet: TestWallet,
  options: MovementOptions,
): Promise<TxRef> {
  const direction =
    options.direction ?? (options.kind === 'BET' ? 'DEBIT' : 'CREDIT');
  const delta = direction === 'DEBIT' ? `-${options.amount}` : options.amount;

  return inTx(pool, async (c) => {
    const { rows } = await c.query<{
      before: string;
      after: string;
      version: number;
    }>(
      `UPDATE wallets
          SET balance = balance + $2::numeric, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING balance - $2::numeric AS before, balance AS after, version`,
      [wallet.walletId, delta],
    );
    const moved = rows[0];
    if (!moved) throw new Error(`wallet ${wallet.walletId} not found`);

    const tx = await insertTransaction(c, wallet, {
      kind: options.kind,
      amount: options.amount,
      reference_external_transaction_id: options.ref?.externalId ?? null,
      reference_transaction_id: options.ref?.txId ?? null,
      status: 'PROCESSED',
      balance_snapshot: moved.after,
      processed_at: new Date(),
    });

    await c.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, 'BRL', $7, $8)`,
      [
        crypto.randomUUID(),
        wallet.walletId,
        tx.txId,
        moved.version,
        direction,
        options.amount,
        moved.before,
        moved.after,
      ],
    );

    return tx;
  });
}

/** Reads the current balance and version of a wallet. */
export async function readWallet(
  pool: Pool,
  walletId: string,
): Promise<{ balance: string; version: number }> {
  const { rows } = await pool.query<{ balance: string; version: number }>(
    `SELECT balance, version FROM wallets WHERE id = $1`,
    [walletId],
  );
  const wallet = rows[0];
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  return wallet;
}
