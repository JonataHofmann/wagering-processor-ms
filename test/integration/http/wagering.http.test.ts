import { TestApp, startTestApp } from '@/test/support/http-app';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  // invariante final de toda a suíte: nenhum saldo diverge do ledger
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await t?.close();
});

type Json = Record<string, any>;

interface TestWallet {
  walletId: string;
  playerId: string;
}

async function openWallet(
  balance: string,
  currency = 'BRL',
): Promise<TestWallet> {
  const playerId = crypto.randomUUID();
  const response = await t.request('/wallets', {
    method: 'POST',
    body: { playerId, initialBalance: { amount: balance, currency } },
  });
  const body = (await response.json()) as Json;
  return { walletId: body.id, playerId };
}

interface Operation {
  kind: string;
  amount: string;
  externalId?: string;
  reference?: string;
  roundId?: string;
  currency?: string;
  playerId?: string;
  idempotencyKey?: string;
}

function payload(w: TestWallet, op: Operation) {
  const externalTransactionId = op.externalId ?? crypto.randomUUID();
  return {
    key: op.idempotencyKey ?? `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: op.playerId ?? w.playerId,
      walletId: w.walletId,
      roundId: op.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: op.kind,
      money: { amount: op.amount, currency: op.currency ?? 'BRL' },
      ...(op.reference !== undefined
        ? { referenceExternalTransactionId: op.reference }
        : {}),
    },
  };
}

async function submit(
  w: TestWallet,
  op: Operation,
): Promise<{ status: number; body: Json; externalId: string }> {
  const { key, body } = payload(w, op);
  const response = await t.request('/wagering/transactions', {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': key },
  });
  return {
    status: response.status,
    body: (await response.json()) as Json,
    externalId: body.externalTransactionId,
  };
}

async function balanceOf(
  w: TestWallet,
): Promise<{ amount: string; version: number }> {
  const body = (await (
    await t.request(`/wallets/${w.walletId}`)
  ).json()) as Json;
  return { amount: body.balance.amount, version: body.version };
}

async function ledgerCount(w: TestWallet): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    t.db.appUrl,
    `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1`,
    [w.walletId],
  );
  return Number(row!.n);
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await queryOnce<{ event_type: string }>(
    t.db.appUrl,
    `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY event_type`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

// ================================================================== BET

describe('BET', () => {
  test('200 PROCESSED, debita e devolve o saldo no formato do enunciado', async () => {
    const w = await openWallet('1000.00');
    const { status, body } = await submit(w, { kind: 'BET', amount: '25.00' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: null,
    });
    expect(await balanceOf(w)).toEqual({ amount: '975.00', version: 2 });
    expect(await eventsOf(body.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('422 REJECTED com INSUFFICIENT_FUNDS, sem mexer no saldo nem no ledger', async () => {
    const w = await openWallet('10.00');
    const { status, body } = await submit(w, { kind: 'BET', amount: '10.01' });

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00' },
    });
    expect(await balanceOf(w)).toEqual({ amount: '10.00', version: 1 });
    expect(await ledgerCount(w)).toBe(1); // só o OPENING
    expect(await eventsOf(body.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);
  });
});

// ================================================================== idempotência

describe('idempotência', () => {
  test('requisição idêntica: mesma resposta, idempotentReplay true, saldo observado naquele momento', async () => {
    const w = await openWallet('100.00');
    const op = {
      kind: 'BET',
      amount: '30.00',
      externalId: crypto.randomUUID(),
    };

    const first = await submit(w, op);
    await submit(w, { kind: 'BET', amount: '10.00' }); // o saldo muda depois
    const replay = await submit(w, op);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('70.00'); // o saldo da época, não o atual (60.00)
    expect(await balanceOf(w)).toEqual({ amount: '60.00', version: 3 });
  });

  test('replay de uma rejeição devolve a mesma rejeição', async () => {
    const w = await openWallet('5.00');
    const op = {
      kind: 'BET',
      amount: '50.00',
      externalId: crypto.randomUUID(),
    };
    const first = await submit(w, op);
    const replay = await submit(w, op);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('mesma key com payload diferente: 409, nunca replay', async () => {
    const w = await openWallet('100.00');
    const externalId = crypto.randomUUID();
    await submit(w, { kind: 'BET', amount: '10.00', externalId });
    const conflict = await submit(w, {
      kind: 'BET',
      amount: '11.00',
      externalId,
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(w)).toEqual({ amount: '90.00', version: 2 });
  });

  test('"25" e "25.00" são o mesmo payload (valor normalizado no hash)', async () => {
    const w = await openWallet('100.00');
    const externalId = crypto.randomUUID();
    await submit(w, { kind: 'BET', amount: '25.00', externalId });
    const replay = await submit(w, { kind: 'BET', amount: '25', externalId });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('400 sem o header Idempotency-Key', async () => {
    const w = await openWallet('100.00');
    const { body } = payload(w, { kind: 'BET', amount: '1.00' });
    const response = await t.request('/wagering/transactions', {
      method: 'POST',
      body,
    });
    expect(response.status).toBe(400);
  });
});

// ================================================================== WIN e LOSS

describe('WIN e LOSS', () => {
  test('WIN credita, com ou sem referência à BET', async () => {
    const w = await openWallet('100.00');
    const bet = await submit(w, { kind: 'BET', amount: '10.00' });
    const winWithRef = await submit(w, {
      kind: 'WIN',
      amount: '50.00',
      reference: bet.externalId,
    });
    const winWithoutRef = await submit(w, { kind: 'WIN', amount: '5.00' });

    expect(winWithRef.status).toBe(200);
    expect(winWithoutRef.status).toBe(200);
    expect(await balanceOf(w)).toEqual({ amount: '145.00', version: 4 });
  });

  test('LOSS registra o resultado sem mover saldo, sem lançamento, mas com evento', async () => {
    const w = await openWallet('100.00');
    const { status, body } = await submit(w, { kind: 'LOSS', amount: '10.00' });

    expect(status).toBe(200);
    expect(body.status).toBe('PROCESSED');
    expect(await balanceOf(w)).toEqual({ amount: '100.00', version: 1 });
    expect(await ledgerCount(w)).toBe(1);
    expect(await eventsOf(body.transactionId)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });
});

// ================================================================== REFUND e ROLLBACK

describe('REFUND e ROLLBACK', () => {
  test('REFUND devolve a BET; um segundo REFUND da mesma BET é rejeitado', async () => {
    const w = await openWallet('100.00');
    const bet = await submit(w, { kind: 'BET', amount: '40.00' });
    const refund = await submit(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: bet.externalId,
    });
    const again = await submit(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: bet.externalId,
    });

    expect(refund.status).toBe(200);
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
  });

  test('ROLLBACK depois de REFUND da mesma BET também é rejeitado (reversão única)', async () => {
    const w = await openWallet('100.00');
    const bet = await submit(w, { kind: 'BET', amount: '40.00' });
    await submit(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: bet.externalId,
    });
    const rollback = await submit(w, {
      kind: 'ROLLBACK',
      amount: '40.00',
      reference: bet.externalId,
    });
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  test('ROLLBACK de WIN debita (inverso da referência)', async () => {
    const w = await openWallet('100.00');
    const win = await submit(w, { kind: 'WIN', amount: '30.00' });
    const rollback = await submit(w, {
      kind: 'ROLLBACK',
      amount: '30.00',
      reference: win.externalId,
    });

    expect(rollback.status).toBe(200);
    expect(await balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
  });

  test('ROLLBACK de WIN já gasto: REVERSAL_INSUFFICIENT_FUNDS, distinto da aposta sem saldo', async () => {
    const w = await openWallet('0.00');
    const win = await submit(w, { kind: 'WIN', amount: '50.00' });
    await submit(w, { kind: 'BET', amount: '45.00' }); // gastou o prêmio
    const rollback = await submit(w, {
      kind: 'ROLLBACK',
      amount: '50.00',
      reference: win.externalId,
    });

    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await balanceOf(w)).toEqual({ amount: '5.00', version: 3 });
  });

  test.each([
    ['REFUND de WIN', 'REFUND', 'WIN', {}, 'REFERENCE_INVALID_KIND'],
    ['valor diferente', 'REFUND', 'BET', { amount: '9.99' }, 'AMOUNT_MISMATCH'],
    [
      'outra rodada',
      'REFUND',
      'BET',
      { roundId: 'round-2' },
      'REFERENCE_CONTEXT_MISMATCH',
    ],
  ])('422 para %s', async (_, kind, referenceKind, overrides, code) => {
    const w = await openWallet('100.00');
    const reference = await submit(w, { kind: referenceKind, amount: '10.00' });
    const reversal = await submit(w, {
      kind,
      amount: '10.00',
      reference: reference.externalId,
      ...overrides,
    });
    expect(reversal.status).toBe(422);
    expect(reversal.body.failureCode).toBe(code);
  });

  test('REFUND antes da BET: 202 PENDING_REFERENCE, sem mexer no saldo', async () => {
    const w = await openWallet('100.00');
    const { status, body } = await submit(w, {
      kind: 'REFUND',
      amount: '10.00',
      reference: 'bet-que-ainda-nao-chegou',
    });

    expect(status).toBe(202);
    expect(body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: null,
      failureCode: null,
    });
    expect(await balanceOf(w)).toEqual({ amount: '100.00', version: 1 });
    expect(await eventsOf(body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });
});

// ================================================================== outras rejeições e validações

describe('outras rejeições', () => {
  test('422 CURRENCY_MISMATCH', async () => {
    const w = await openWallet('100.00');
    const { status, body } = await submit(w, {
      kind: 'BET',
      amount: '10.00',
      currency: 'USD',
    });
    expect(status).toBe(422);
    expect(body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('422 WALLET_PLAYER_MISMATCH, sem expor o saldo da wallet alheia', async () => {
    const w = await openWallet('100.00');
    const { status, body } = await submit(w, {
      kind: 'BET',
      amount: '10.00',
      playerId: crypto.randomUUID(),
    });
    expect(status).toBe(422);
    expect(body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(body.balance).toBeNull();
  });

  test('404 WALLET_NOT_FOUND', async () => {
    const { status, body } = await submit(
      { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() },
      { kind: 'BET', amount: '1.00' },
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test.each([
    [
      'OPENING submetido',
      { kind: 'OPENING', amount: '1.00' },
      'OPENING_NOT_ALLOWED',
    ],
    [
      'REFUND sem referência',
      { kind: 'REFUND', amount: '1.00' },
      'REFERENCE_REQUIRED',
    ],
    ['valor zero', { kind: 'BET', amount: '0.00' }, 'NON_POSITIVE_AMOUNT'],
    ['valor com 3 casas', { kind: 'BET', amount: '1.005' }, 'INVALID_AMOUNT'],
    [
      'kind desconhecido',
      { kind: 'JACKPOT', amount: '1.00' },
      'VALIDATION_ERROR',
    ],
  ])('400 para %s', async (_, op, code) => {
    const w = await openWallet('100.00');
    const { status, body } = await submit(w, op);
    expect(status).toBe(400);
    expect(body.error.code).toBe(code);
  });
});

// ================================================================== consultas

describe('consultas', () => {
  test('por id interno e por (provider, id externo)', async () => {
    const w = await openWallet('100.00');
    const bet = await submit(w, { kind: 'BET', amount: '10.00' });

    const byId = (await (
      await t.request(`/wagering/transactions/${bet.body.transactionId}`)
    ).json()) as Json;
    const byExternal = (await (
      await t.request(
        `/providers/provider-a/wagering/transactions/${bet.externalId}`,
      )
    ).json()) as Json;

    expect(byId).toEqual(byExternal);
    expect(byId).toMatchObject({
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '10.00', currency: 'BRL' },
    });
  });

  test('404 TRANSACTION_NOT_FOUND', async () => {
    const response = await t.request(
      `/wagering/transactions/${crypto.randomUUID()}`,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as Json).error.code).toBe(
      'TRANSACTION_NOT_FOUND',
    );
  });
});

// ================================================================== concorrência (prévia da etapa 12)

describe('concorrência', () => {
  test('cenário do enunciado: 100.00 e duas apostas de 80.00 simultâneas', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all([
      submit(w, { kind: 'BET', amount: '80.00' }),
      submit(w, { kind: 'BET', amount: '80.00' }),
    ]);

    expect(results.map((r) => r.body.status).sort()).toEqual([
      'PROCESSED',
      'REJECTED',
    ]);
    expect(
      results.find((r) => r.body.status === 'REJECTED')!.body.failureCode,
    ).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(w)).toEqual({ amount: '20.00', version: 2 });

    const [debits] = await queryOnce<{ n: string }>(
      t.db.appUrl,
      `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [w.walletId],
    );
    expect(debits!.n).toBe('1');
  });

  test('a mesma aposta 50 vezes em paralelo gera um único débito', async () => {
    const w = await openWallet('100.00');
    const op = {
      kind: 'BET',
      amount: '10.00',
      externalId: crypto.randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(w, op)),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await balanceOf(w)).toEqual({ amount: '90.00', version: 2 });
  });
});
