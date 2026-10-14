import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { Money } from '@/src/shared/domain/money';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import {
  connectPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let t: TestApp;
let p: Persistence; // acesso direto ao mesmo banco, para preparar e conferir dados

beforeAll(async () => {
  t = await startTestApp();
  p = await connectPersistence(t.db);
});
afterAll(async () => {
  await p?.orm.close(true);
  await t?.close();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function createWallet(
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await t.request('/wallets', {
    method: 'POST',
    body,
    headers,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function newPlayer(): string {
  return crypto.randomUUID();
}

/** Aposta gravada direto pelos repositórios (o endpoint de apostas vem na etapa 11). */
async function placeBet(walletId: string, amount: string): Promise<void> {
  await p.tm.runInTransaction(async () => {
    const wallet = (await p.wallets.findByIdForUpdate(walletId))!;
    const expectedVersion = wallet.version;
    const externalId = crypto.randomUUID();
    const bet = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      createdAt: p.clock.now(),
    });
    const entry = wallet.debit({
      money: brl(amount),
      transactionId: bet.id,
      entryId: crypto.randomUUID(),
      at: p.clock.now(),
    });
    bet.markProcessed({ at: p.clock.now(), balanceSnapshot: wallet.balance });
    await p.wallets.update(wallet, expectedVersion);
    await p.transactions.insert(bet);
    await p.ledger.append(entry);
  });
}

// ============================================================== POST /wallets

describe('POST /wallets', () => {
  test('201 com saldo inicial e versão 1, no formato do enunciado', async () => {
    const playerId = newPlayer();
    const { status, body } = await createWallet({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('saldo inicial > 0 grava OPENING, lançamento CREDIT e 2 eventos, na mesma transação', async () => {
    const { body } = await createWallet(
      {
        playerId: newPlayer(),
        initialBalance: { amount: '250.00', currency: 'BRL' },
      },
      { 'x-correlation-id': 'corr-opening-1' },
    );

    const transactions = await queryOnce<{
      kind: string;
      status: string;
      provider_id: string;
    }>(
      t.db.appUrl,
      `SELECT kind, status, provider_id FROM wager_transactions WHERE wallet_id = $1`,
      [body.id],
    );
    expect(transactions).toEqual([
      { kind: 'OPENING', status: 'PROCESSED', provider_id: 'system' },
    ]);

    const ledger = await queryOnce<{
      direction: string;
      amount: string;
      wallet_version: number;
    }>(
      t.db.appUrl,
      `SELECT direction, amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [body.id],
    );
    expect(ledger).toEqual([
      { direction: 'CREDIT', amount: '250.00', wallet_version: 1 },
    ]);

    const events = await queryOnce<{ event_type: string; correlation: string }>(
      t.db.appUrl,
      `SELECT event_type, payload->>'correlationId' AS correlation FROM outbox_messages
        WHERE aggregate_id = $1 ORDER BY event_type`,
      [body.id],
    );
    expect(events).toEqual([
      {
        event_type: 'WagerTransactionProcessed',
        correlation: 'corr-opening-1',
      },
      { event_type: 'WalletBalanceChanged', correlation: 'corr-opening-1' },
    ]);
  });

  test('saldo inicial zero: sem OPENING, sem lançamento, sem evento', async () => {
    const { status, body } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(status).toBe(201);

    const [counts] = await queryOnce<{
      txs: string;
      entries: string;
      events: string;
    }>(
      t.db.appUrl,
      `
      SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = $1) AS txs,
             (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1) AS entries,
             (SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1) AS events`,
      [body.id],
    );
    expect(counts).toEqual({ txs: '0', entries: '0', events: '0' });
  });

  test('409 para wallet duplicada do mesmo jogador e moeda', async () => {
    const playerId = newPlayer();
    await createWallet({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const { status, body } = await createWallet({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('o mesmo jogador pode ter wallets em moedas diferentes', async () => {
    const playerId = newPlayer();
    expect(
      (
        await createWallet({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await createWallet({
          playerId,
          initialBalance: { amount: '10.00', currency: 'USD' },
        })
      ).status,
    ).toBe(201);
  });

  test.each([
    ['corpo vazio', {}, 'VALIDATION_ERROR'],
    [
      'playerId ausente',
      { initialBalance: { amount: '1.00', currency: 'BRL' } },
      'VALIDATION_ERROR',
    ],
    [
      'playerId fora do formato UUID',
      { playerId: 'abc', initialBalance: { amount: '1.00', currency: 'BRL' } },
      'VALIDATION_ERROR',
    ],
    [
      'initialBalance ausente',
      { playerId: crypto.randomUUID() },
      'VALIDATION_ERROR',
    ],
    [
      'amount como número',
      {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: 1000, currency: 'BRL' },
      },
      'VALIDATION_ERROR',
    ],
    [
      'amount com 3 casas',
      {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.005', currency: 'BRL' },
      },
      'INVALID_AMOUNT',
    ],
    [
      'amount negativo',
      {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '-1.00', currency: 'BRL' },
      },
      'INVALID_AMOUNT',
    ],
    [
      'notação científica',
      {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1e3', currency: 'BRL' },
      },
      'INVALID_AMOUNT',
    ],
    [
      'moeda minúscula',
      {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'brl' },
      },
      'INVALID_CURRENCY',
    ],
  ])('400 para %s', async (_, body, code) => {
    const response = await createWallet(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
  });

  test('400 lista todas as violações de uma vez', async () => {
    const { status, body } = await createWallet({ playerId: 'abc' });
    expect(status).toBe(400);
    expect(body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'playerId',
      'initialBalance',
      'initialBalance.amount',
      'initialBalance.currency',
    ]);
  });

  test('JSON malformado é 400, não 500', async () => {
    const response = await t.request('/wallets', {
      method: 'POST',
      body: '{"playerId": ',
    });
    expect(response.status).toBe(400);
  });
});

// ============================================================== GET /wallets/:id

describe('GET /wallets/:walletId', () => {
  test('200 com o estado atual', async () => {
    const { body: created } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    await placeBet(created.id, '25.00');

    const response = await t.request(`/wallets/${created.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: created.id,
      balance: { amount: '75.00', currency: 'BRL' },
      version: 2,
    });
  });

  test('404 para wallet inexistente', async () => {
    const response = await t.request(`/wallets/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error.code).toBe(
      'WALLET_NOT_FOUND',
    );
  });

  test('400 para id fora do formato UUID', async () => {
    const response = await t.request('/wallets/nao-e-uuid');
    expect(response.status).toBe(400);
  });
});

// ============================================================== GET /wallets/:id/ledger

describe('GET /wallets/:walletId/ledger', () => {
  test('pagina com cursor estável e opaco até o fim', async () => {
    const { body: created } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    for (const amount of ['10.00', '20.00', '30.00', '5.00'])
      await placeBet(created.id, amount);

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const response = await t.request(`/wallets/${created.id}/ledger${query}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: Array<{ walletVersion: number }>;
        nextCursor: string | null;
      };
      versions.push(...page.items.map((i) => i.walletVersion));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  test('cada item traz valores como MoneyProps e o saldo antes e depois', async () => {
    const { body: created } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    await placeBet(created.id, '20.00');

    const page = (await (
      await t.request(`/wallets/${created.id}/ledger`)
    ).json()) as { items: any[] };
    expect(page.items[1]).toMatchObject({
      walletVersion: 2,
      direction: 'DEBIT',
      money: { amount: '20.00', currency: 'BRL' },
      balanceBefore: { amount: '50.00', currency: 'BRL' },
      balanceAfter: { amount: '30.00', currency: 'BRL' },
    });
  });

  test('wallet sem movimentos devolve página vazia', async () => {
    const { body: created } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const page = await (
      await t.request(`/wallets/${created.id}/ledger`)
    ).json();
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  test.each([
    ['cursor inválido', '?cursor=nao-e-um-cursor'],
    ['limit zero', '?limit=0'],
    ['limit acima do máximo', '?limit=201'],
    ['limit não numérico', '?limit=abc'],
  ])('400 para %s', async (_, query) => {
    const { body: created } = await createWallet({
      playerId: newPlayer(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    const response = await t.request(`/wallets/${created.id}/ledger${query}`);
    expect(response.status).toBe(400);
  });

  test('404 para wallet inexistente', async () => {
    const response = await t.request(`/wallets/${crypto.randomUUID()}/ledger`);
    expect(response.status).toBe(404);
  });
});
