import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import {
  connectPersistence,
  type Persistence,
} from '@/test/support/persistence';
import { queryOnce } from '@/test/support/pg';
import { createTestQueues, type TestQueues, waitFor } from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let queues: TestQueues;
let t: TestApp;
let p: Persistence;
let api: ReturnType<typeof walletClient>;
let metrics: Metrics;

beforeAll(async () => {
  queues = await createTestQueues({ maxReceiveCount: 3 });
  t = await startTestApp({ sqs: queues.config });
  p = await connectPersistence(t.db);
  api = walletClient(t.request);
  metrics = t.app.get<Metrics>(METRICS);
}, 30_000);

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await p?.close();
  await t?.close(); // para o consumer antes de fechar o banco
  await queues?.drop();
}, 30_000);

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

function message(w: TestWallet, data: Record<string, unknown> = {}) {
  const externalTransactionId = crypto.randomUUID();
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
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

async function transactionStatus(
  idempotencyKey: string,
): Promise<{ status: string; failure_code: string | null } | undefined> {
  const [row] = await queryOnce<{
    status: string;
    failure_code: string | null;
  }>(
    t.db.appUrl,
    `SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return row;
}

async function queueDrained(): Promise<void> {
  await waitFor(
    async () => (await queues.depth()) === 0,
    'main queue to be empty',
  );
}

describe('consumer SQS ponta a ponta', () => {
  test('mensagem válida: processada pelo caso de uso e apagada da fila', async () => {
    const w = await newWallet('100.00');
    const msg = message(w);
    await queues.send(msg, { groupId: w.walletId });

    await waitFor(
      async () =>
        (await transactionStatus(msg.data.idempotencyKey))?.status ===
        'PROCESSED',
      'transaction processed',
    );
    await queueDrained();
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });

    // histograma de duração de processamento populado de verdade pelo loop real do consumer
    const processed = metrics
      .snapshot()
      .find(
        (s) =>
          s.kind === 'histogram' &&
          s.name === 'sqs_message_processing_duration_seconds',
      );
    expect(processed).toBeDefined();
    expect(
      processed && 'count' in processed ? processed.count : 0,
    ).toBeGreaterThan(0);
  });

  test('a mesma mensagem enviada duas vezes: um único efeito, as duas apagadas', async () => {
    const w = await newWallet('100.00');
    const msg = message(w);
    await queues.send(msg, { groupId: w.walletId });
    await queues.send(msg, { groupId: w.walletId }); // outro deduplicationId: o SQS entrega as duas

    await waitFor(
      async () =>
        (await transactionStatus(msg.data.idempotencyKey))?.status ===
        'PROCESSED',
      'transaction processed',
    );
    await queueDrained();
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });

    const [inbox] = await queryOnce<{ n: string }>(
      t.db.appUrl,
      `SELECT count(*) AS n FROM inbox_messages WHERE message_id = $1`,
      [msg.messageId],
    );
    expect(inbox!.n).toBe('1');
  });

  test('rejeição de negócio: REJECTED gravada e mensagem apagada (não vai para a DLQ)', async () => {
    const w = await newWallet('10.00');
    const msg = message(w, { money: { amount: '50.00', currency: 'BRL' } });
    await queues.send(msg, { groupId: w.walletId });

    await waitFor(
      async () =>
        (await transactionStatus(msg.data.idempotencyKey))?.status ===
        'REJECTED',
      'transaction rejected',
    );
    await queueDrained();
    expect(
      (await transactionStatus(msg.data.idempotencyKey))?.failure_code,
    ).toBe('INSUFFICIENT_FUNDS');
  });

  test('mensagens do mesmo grupo (wallet) são processadas em ordem', async () => {
    const w = await newWallet('100.00');
    const first = message(w, { money: { amount: '80.00', currency: 'BRL' } });
    const second = message(w, { money: { amount: '30.00', currency: 'BRL' } });
    await queues.send(first, { groupId: w.walletId });
    await queues.send(second, { groupId: w.walletId });

    await waitFor(
      async () =>
        (await transactionStatus(second.data.idempotencyKey)) !== undefined,
      'second processed',
    );
    expect((await transactionStatus(first.data.idempotencyKey))?.status).toBe(
      'PROCESSED',
    );
    expect(await transactionStatus(second.data.idempotencyKey)).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
  });

  test('mensagem inválida: vai direto para a DLQ com o motivo, sem retry', async () => {
    const dlqBefore = metrics.value('sqs_dead_letter_messages_total', {
      queue: queues.config.queues.wagerTransactions,
      reason: 'INVALID_MESSAGE',
    });
    await queues.send('{"isto nao e": ', { groupId: 'invalid' });

    await waitFor(
      async () => (await queues.deadLetters()).length > 0,
      'message in DLQ',
    );
    const [dead] = await queues.deadLetters();
    expect(dead!.attributes['dlq-reason']?.StringValue).toBe('INVALID_MESSAGE');
    expect(dead!.attributes['receive-count']?.StringValue).toBe('1'); // primeira tentativa: sem retry
    await queueDrained();
    // >= (não ===): SQS é at-least-once de verdade — sob carga, a mesma mensagem
    // pode ser recebida mais de uma vez antes do delete, e cada entrega gera seu
    // próprio dead-letter corretamente (não é bug, é o modelo de entrega do SQS).
    expect(
      metrics.value('sqs_dead_letter_messages_total', {
        queue: queues.config.queues.wagerTransactions,
        reason: 'INVALID_MESSAGE',
      }),
    ).toBeGreaterThanOrEqual(dlqBefore + 1);
  });

  test('falha transitória: a mensagem volta para a fila e é processada quando a wallet é liberada', async () => {
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

    const retriesBefore = metrics.value('sqs_message_retries_total', {
      queue: queues.config.queues.wagerTransactions,
    });
    await queues.send(msg, { groupId: w.walletId });
    await Bun.sleep(2_500); // a primeira tentativa estoura o lock_timeout (2 s) → retry
    expect(await transactionStatus(msg.data.idempotencyKey)).toBeUndefined();
    expect(
      metrics.value('sqs_message_retries_total', {
        queue: queues.config.queues.wagerTransactions,
      }),
    ).toBeGreaterThan(retriesBefore);

    release();
    await holder;

    await waitFor(
      async () =>
        (await transactionStatus(msg.data.idempotencyKey))?.status ===
        'PROCESSED',
      'processed after retry',
    );
    await queueDrained();
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });
});
