import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import { createTestQueues, type TestQueues, waitFor } from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const LOOKUP = { backoffBaseMs: 200, backoffMaxMs: 800, ttlMs: 2_000 };
const SCHEDULER = { batchSize: 20, leaseMs: 2_000, idleIntervalMs: 100 };

let queues: TestQueues;
let t: TestApp;
let api: ReturnType<typeof walletClient>;

beforeAll(async () => {
  queues = await createTestQueues();
  t = await startTestApp({
    sqs: queues.config,
    referenceLookup: LOOKUP,
    scheduler: SCHEDULER,
  });
  api = walletClient(t.request);
}, 30_000);

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await t?.close();
  await queues?.drop();
}, 30_000);

async function statusOf(
  transactionId: string,
): Promise<{ status: string; failure_code: string | null }> {
  const [row] = await queryOnce<{
    status: string;
    failure_code: string | null;
  }>(
    t.db.appUrl,
    `SELECT status, failure_code FROM wager_transactions WHERE id = $1`,
    [transactionId],
  );
  return row!;
}

async function statusByKey(
  idempotencyKey: string,
): Promise<string | undefined> {
  const [row] = await queryOnce<{ status: string }>(
    t.db.appUrl,
    `SELECT status FROM wager_transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return row?.status;
}

function message(w: TestWallet, data: Record<string, unknown>) {
  const externalTransactionId =
    (data.externalTransactionId as string) ?? crypto.randomUUID();
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
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      ...data,
    },
  };
}

describe('pending reference scheduler, end to end', () => {
  test('REFUND delivered before the BET (HTTP): resolved on its own when the BET arrives', async () => {
    const { wallet } = await api.openWallet('100.00');
    const betId = crypto.randomUUID();

    const refund = await api.submit(wallet, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });
    expect(refund.status).toBe(202);

    await api.submit(wallet, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
    });
    await waitFor(
      async () =>
        (await statusOf(refund.body.transactionId)).status === 'PROCESSED',
      'refund resolved',
    );
    expect(await api.balanceOf(wallet)).toEqual({
      amount: '100.00',
      version: 3,
    });
  });

  test('ROLLBACK delivered via the queue before the WIN: both processed, in the correct order of effects', async () => {
    const { wallet } = await api.openWallet('10.00');
    const winId = crypto.randomUUID();
    const rollback = message(wallet, {
      kind: 'ROLLBACK',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: winId,
    });
    const win = message(wallet, {
      kind: 'WIN',
      money: { amount: '30.00', currency: 'BRL' },
      externalTransactionId: winId,
    });

    await queues.send(rollback, { groupId: wallet.walletId });
    await queues.send(win, { groupId: wallet.walletId });

    await waitFor(
      async () =>
        (await statusByKey(rollback.data.idempotencyKey)) === 'PROCESSED',
      'rollback resolved',
      20_000,
    );
    expect(await statusByKey(win.data.idempotencyKey)).toBe('PROCESSED');
    expect(await api.balanceOf(wallet)).toEqual({
      amount: '10.00',
      version: 3,
    }); // +30 from the WIN, -30 from the ROLLBACK
  });

  test('reference that never arrives: REJECTED with REFERENCE_NOT_FOUND after the deadline, without manual intervention', async () => {
    const { wallet } = await api.openWallet('100.00');
    const refund = await api.submit(wallet, {
      kind: 'REFUND',
      amount: '40.00',
      reference: crypto.randomUUID(),
    });

    await waitFor(
      async () =>
        (await statusOf(refund.body.transactionId)).status === 'REJECTED',
      'expired',
      10_000,
    );
    expect((await statusOf(refund.body.transactionId)).failure_code).toBe(
      'REFERENCE_NOT_FOUND',
    );
    expect(await api.balanceOf(wallet)).toEqual({
      amount: '100.00',
      version: 1,
    });
  });
});
