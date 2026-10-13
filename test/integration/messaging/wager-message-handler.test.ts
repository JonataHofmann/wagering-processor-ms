import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from '@/src/modules/messaging/application/ports/inbox.repository';
import { ProcessWagerTransactionUseCase } from '@/src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerMessageHandler } from '@/src/modules/wagering/infrastructure/sqs/wager-message.handler';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import {
  connectPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let t: TestApp;
let p: Persistence;
let handler: WagerMessageHandler;
let api: ReturnType<typeof walletClient>;

beforeAll(async () => {
  t = await startTestApp();
  p = await connectPersistence(t.db);
  api = walletClient(t.request);
  // o handler usa as MESMAS instâncias que a aplicação (caso de uso, transação, inbox)
  handler = new WagerMessageHandler(
    t.app.get(ProcessWagerTransactionUseCase),
    t.app.get<TransactionManager>(TRANSACTION_MANAGER),
    t.app.get<InboxRepository>(INBOX_REPOSITORY),
  );
});

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await p?.close();
  await t?.close();
});

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

/** Monta uma mensagem no formato do enunciado. */
function message(
  w: TestWallet,
  data: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
) {
  const externalTransactionId =
    (data.externalTransactionId as string) ?? crypto.randomUUID();
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    ...envelope,
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
}

async function inboxCount(messageId: string): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    t.db.appUrl,
    `SELECT count(*) AS n FROM inbox_messages WHERE message_id = $1 AND processed_at IS NOT NULL`,
    [messageId],
  );
  return Number(row!.n);
}

async function transactionsWithKey(idempotencyKey: string): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    t.db.appUrl,
    `SELECT count(*) AS n FROM wager_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return Number(row!.n);
}

describe('processamento', () => {
  test('mensagem válida: processa pelo mesmo caso de uso, registra a inbox e manda ack', async () => {
    const w = await newWallet('100.00');
    const msg = message(w);
    const disposition = await handler.handle(JSON.stringify(msg));

    expect(disposition).toMatchObject({
      action: 'ack',
      reason: 'processed',
      result: { status: 'PROCESSED' },
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
    expect(await inboxCount(msg.messageId)).toBe(1);
  });

  test('rejeição de negócio é terminal: transação REJECTED gravada e ack (não vai para a DLQ)', async () => {
    const w = await newWallet('10.00');
    const disposition = await handler.handle(
      JSON.stringify(
        message(w, { money: { amount: '50.00', currency: 'BRL' } }),
      ),
    );

    expect(disposition).toMatchObject({
      action: 'ack',
      result: { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' },
    });
  });

  test('o messageId vira causationId dos eventos', async () => {
    const w = await newWallet('100.00');
    const msg = message(w);
    const disposition = await handler.handle(JSON.stringify(msg));
    const transactionId = (disposition as { result: { transactionId: string } })
      .result.transactionId;

    const [event] = await queryOnce<{ causation: string }>(
      t.db.appUrl,
      `SELECT payload->>'causationId' AS causation FROM outbox_messages
        WHERE payload->'data'->>'transactionId' = $1 LIMIT 1`,
      [transactionId],
    );
    expect(event!.causation).toBe(msg.messageId);
  });
});

describe('deduplicação', () => {
  test('a mesma mensagem reentregue: ack como duplicata, sem segundo efeito', async () => {
    const w = await newWallet('100.00');
    const raw = JSON.stringify(message(w));

    expect(await handler.handle(raw)).toMatchObject({
      action: 'ack',
      reason: 'processed',
    });
    expect(await handler.handle(raw)).toEqual({
      action: 'ack',
      reason: 'duplicate',
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });

  test('reentregas simultâneas da mesma mensagem: um único efeito', async () => {
    const w = await newWallet('100.00');
    const raw = JSON.stringify(message(w));
    const dispositions = await Promise.all(
      Array.from({ length: 10 }, () => handler.handle(raw)),
    );

    expect(
      dispositions.filter(
        (d) => d.action === 'ack' && d.reason === 'processed',
      ),
    ).toHaveLength(1);
    expect(
      dispositions.filter(
        (d) => d.action === 'ack' && d.reason === 'duplicate',
      ),
    ).toHaveLength(9);
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });

  test('mensagens diferentes com a mesma idempotency key: a segunda é replay, ambas registradas na inbox', async () => {
    const w = await newWallet('100.00');
    const first = message(w);
    const second = { ...first, messageId: `msg-${crypto.randomUUID()}` };

    await handler.handle(JSON.stringify(first));
    const replay = await handler.handle(JSON.stringify(second));

    expect(replay).toMatchObject({
      action: 'ack',
      reason: 'processed',
      result: { idempotentReplay: true },
    });
    expect(await transactionsWithKey(first.data.idempotencyKey)).toBe(1);
    expect(await inboxCount(first.messageId)).toBe(1);
    expect(await inboxCount(second.messageId)).toBe(1);
  });

  test('o mesmo messageId com outro conteúdo: DLQ, nunca tratado como duplicata', async () => {
    const w = await newWallet('100.00');
    const original = message(w);
    await handler.handle(JSON.stringify(original));

    const tampered = {
      ...original,
      data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
    };
    expect(await handler.handle(JSON.stringify(tampered))).toMatchObject({
      action: 'dead-letter',
      reason: 'MESSAGE_ID_REUSED',
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });
});

describe('mensagens que nunca vão dar certo vão direto para a DLQ', () => {
  test.each([
    ['JSON malformado', () => '{"messageId": '],
    [
      'type desconhecido',
      (w: TestWallet) => JSON.stringify(message(w, {}, { type: 'Other' })),
    ],
    [
      'sem messageId',
      (w: TestWallet) =>
        JSON.stringify({ ...message(w), messageId: undefined }),
    ],
    [
      'sem idempotencyKey',
      (w: TestWallet) =>
        JSON.stringify(message(w, { idempotencyKey: undefined })),
    ],
    [
      'walletId fora do formato',
      (w: TestWallet) => JSON.stringify(message(w, { walletId: 'abc' })),
    ],
  ])('%s → INVALID_MESSAGE', async (_, build) => {
    const w = await newWallet('100.00');
    expect(await handler.handle(build(w))).toMatchObject({
      action: 'dead-letter',
      reason: 'INVALID_MESSAGE',
    });
  });

  test.each([
    [
      'valor com 3 casas',
      { money: { amount: '1.005', currency: 'BRL' } },
      'INVALID_AMOUNT',
    ],
    ['OPENING submetido pela fila', { kind: 'OPENING' }, 'OPENING_NOT_ALLOWED'],
    [
      'wallet inexistente',
      { walletId: crypto.randomUUID() },
      'WALLET_NOT_FOUND',
    ],
  ])('%s → DLQ com o código do erro', async (_, data, reason) => {
    const w = await newWallet('100.00');
    expect(
      await handler.handle(JSON.stringify(message(w, data))),
    ).toMatchObject({ action: 'dead-letter', reason });
  });

  test('mensagem rejeitada por validação não deixa nada gravado, nem na inbox', async () => {
    const w = await newWallet('100.00');
    const msg = message(w, { kind: 'OPENING' });
    await handler.handle(JSON.stringify(msg));
    expect(await inboxCount(msg.messageId)).toBe(0);
  });
});

describe('falha transitória', () => {
  test('wallet travada além do lock_timeout → retry, e nada gravado (nem na inbox)', async () => {
    const w = await newWallet('100.00');
    const msg = message(w);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = p.tm.runInTransaction(async () => {
      await p.wallets.findByIdForUpdate(w.walletId);
      locked();
      await held;
    });
    await lockTaken;

    const disposition = await handler.handle(JSON.stringify(msg));
    release();
    await holder;

    expect(disposition.action).toBe('retry');
    expect(await inboxCount(msg.messageId)).toBe(0); // a inbox foi desfeita junto com o resto

    // a reentrega posterior processa normalmente
    expect(await handler.handle(JSON.stringify(msg))).toMatchObject({
      action: 'ack',
      reason: 'processed',
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });
});
