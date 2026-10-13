import type { AppRole } from '@/src/config/app-roles';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { queryOnce } from '@/test/support/pg';
import { createTestQueues, type TestQueues, waitFor } from '@/test/support/sqs';
import { walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const FAST_RELAY = { batchSize: 10, leaseMs: 5_000, idleIntervalMs: 100 };

async function pendingCount(t: TestApp): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(
    t.db.appUrl,
    `SELECT count(*) AS n FROM outbox_messages WHERE published_at IS NULL`,
  );
  return Number(row!.n);
}

describe('relay publicando no SQS', () => {
  let queues: TestQueues;
  let t: TestApp;

  beforeAll(async () => {
    queues = await createTestQueues();
    t = await startTestApp({
      roles: new Set<AppRole>(['api', 'relay']),
      sqs: queues.config,
      relay: FAST_RELAY,
    });
  }, 30_000);

  afterAll(async () => {
    await t?.close();
    await queues?.drop();
  }, 30_000);

  test('uma aposta pela API vira eventos no wallet-events.fifo, depois do commit', async () => {
    const api = walletClient(t.request);
    const { wallet } = await api.openWallet('100.00');
    const bet = await api.submit(wallet, { kind: 'BET', amount: '25.00' });

    await waitFor(async () => (await pendingCount(t)) === 0, 'outbox drained');
    const events = await queues.drainEvents();
    const ofBet = events.filter(
      (e) => e.body.data?.transactionId === bet.body.transactionId,
    );

    expect(ofBet.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of ofBet) {
      expect(event.groupId).toBe(wallet.walletId); // ordem por wallet
      expect(event.deduplicationId).toBe(event.body.eventId); // deduplicação pelo eventId
      expect(event.body.aggregateId).toBe(wallet.walletId);
    }
    const balanceChanged = ofBet.find(
      (e) => e.eventType === 'WalletBalanceChanged',
    )!;
    expect(balanceChanged.body.data).toMatchObject({
      direction: 'DEBIT',
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('o corpo publicado é exatamente o envelope gravado na outbox', async () => {
    const api = walletClient(t.request);
    const { wallet } = await api.openWallet('10.00');
    await waitFor(async () => (await pendingCount(t)) === 0, 'outbox drained');

    const events = await queues.drainEvents();
    const opening = events.find(
      (e) =>
        e.body.aggregateId === wallet.walletId &&
        e.eventType === 'WalletBalanceChanged',
    )!;
    const [stored] = await queryOnce<{ payload: Record<string, unknown> }>(
      t.db.appUrl,
      `SELECT payload FROM outbox_messages WHERE id = $1`,
      [opening.body.eventId],
    );
    expect(opening.body).toEqual(stored!.payload);
  });
});

describe('instância sem o papel relay', () => {
  let queues: TestQueues;
  let t: TestApp;

  beforeAll(async () => {
    queues = await createTestQueues();
    t = await startTestApp({
      roles: new Set<AppRole>(['api']),
      sqs: queues.config,
      relay: FAST_RELAY,
    });
  }, 30_000);

  afterAll(async () => {
    await t?.close();
    await queues?.drop();
  }, 30_000);

  test('grava na outbox mas não publica', async () => {
    await walletClient(t.request).openWallet('10.00');
    await Bun.sleep(1_000);
    expect(await pendingCount(t)).toBe(2); // WagerTransactionProcessed + WalletBalanceChanged da abertura
    expect(await queues.drainEvents()).toHaveLength(0);
  });
});
