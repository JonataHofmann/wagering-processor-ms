import { WagerMessageHandler } from '@/src/modules/wagering/infrastructure/sqs/wager-message.handler';
import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
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
let metrics: Metrics;

beforeAll(async () => {
  t = await startTestApp();
  p = await connectPersistence(t.db);
  api = walletClient(t.request);
  // the SAME handler the application uses (use case, transaction, inbox, metrics)
  handler = t.app.get(WagerMessageHandler);
  metrics = t.app.get<Metrics>(METRICS);
});

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await p?.close();
  await t?.close();
});

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

/** Builds a message in the format described in the spec. */
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

describe('processing', () => {
  test('valid message: processed by the same use case, recorded in the inbox and acked', async () => {
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

  test('business rejection is terminal: REJECTED transaction recorded and acked (does not go to the DLQ)', async () => {
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

  test('the messageId becomes the causationId of the events', async () => {
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

describe('deduplication', () => {
  test('the same message redelivered: acked as duplicate, no second effect', async () => {
    const w = await newWallet('100.00');
    const raw = JSON.stringify(message(w));
    const before = metrics.value('wagering_duplicates_detected_total', {
      source: 'inbox_message',
    });

    expect(await handler.handle(raw)).toMatchObject({
      action: 'ack',
      reason: 'processed',
    });
    expect(await handler.handle(raw)).toEqual({
      action: 'ack',
      reason: 'duplicate',
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
    expect(
      metrics.value('wagering_duplicates_detected_total', {
        source: 'inbox_message',
      }),
    ).toBe(before + 1);
  });

  test('concurrent redeliveries of the same message: a single effect', async () => {
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

  test('different messages with the same idempotency key: the second is a replay, both recorded in the inbox', async () => {
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

  test('the same messageId with different content: DLQ, never treated as duplicate', async () => {
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

describe('messages that will never succeed go straight to the DLQ', () => {
  test.each([
    ['malformed JSON', () => '{"messageId": '],
    [
      'unknown type',
      (w: TestWallet) => JSON.stringify(message(w, {}, { type: 'Other' })),
    ],
    [
      'missing messageId',
      (w: TestWallet) =>
        JSON.stringify({ ...message(w), messageId: undefined }),
    ],
    [
      'missing idempotencyKey',
      (w: TestWallet) =>
        JSON.stringify(message(w, { idempotencyKey: undefined })),
    ],
    [
      'walletId with invalid format',
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
      'value with 3 decimal places',
      { money: { amount: '1.005', currency: 'BRL' } },
      'INVALID_AMOUNT',
    ],
    ['OPENING submitted via the queue', { kind: 'OPENING' }, 'OPENING_NOT_ALLOWED'],
    [
      'nonexistent wallet',
      { walletId: crypto.randomUUID() },
      'WALLET_NOT_FOUND',
    ],
  ])('%s → DLQ with the error code', async (_, data, reason) => {
    const w = await newWallet('100.00');
    expect(
      await handler.handle(JSON.stringify(message(w, data))),
    ).toMatchObject({ action: 'dead-letter', reason });
  });

  test('message rejected by validation leaves nothing recorded, not even in the inbox', async () => {
    const w = await newWallet('100.00');
    const msg = message(w, { kind: 'OPENING' });
    await handler.handle(JSON.stringify(msg));
    expect(await inboxCount(msg.messageId)).toBe(0);
  });
});

describe('transient failure', () => {
  test('wallet locked past the lock_timeout → retry, and nothing recorded (not even in the inbox)', async () => {
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

    const lockConflictsBefore = metrics.value('database_lock_conflicts_total', {
      sql_state: '55P03',
    });
    const disposition = await handler.handle(JSON.stringify(msg));
    release();
    await holder;

    expect(disposition.action).toBe('retry');
    expect(await inboxCount(msg.messageId)).toBe(0); // the inbox was rolled back along with everything else
    expect(
      metrics.value('database_lock_conflicts_total', { sql_state: '55P03' }),
    ).toBe(lockConflictsBefore + 1);

    // the later redelivery processes normally
    expect(await handler.handle(JSON.stringify(msg))).toMatchObject({
      action: 'ack',
      reason: 'processed',
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '75.00', version: 2 });
  });
});
