import { Persistence, createPersistence } from '@/test/support/persistence';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { InboxMessage } from '@/src/modules/messaging/domain/entities/inbox-message';
import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionKind as Kind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { DuplicateWagerTransactionError } from '@/src/modules/wagering/error/wager-transaction.errors';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { IntegrationEvent } from '@/src/shared/domain/integration-event';
import { Money } from '@/src/shared/domain/money';

let p: Persistence;
let wallet: Wallet;

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const HASH = 'a'.repeat(64);

beforeAll(async () => {
  p = await createPersistence();
  wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl('0.00'),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    openedAt: p.clock.now(),
  }).wallet;
  await p.tm.runInTransaction(() => p.wallets.insert(wallet));
});
afterAll(async () => {
  await p.close();
});

function newTransaction(
  kind: Kind,
  overrides: {
    reference?: WagerTransaction;
    idempotencyKey?: string;
    externalId?: string;
  } = {},
) {
  const externalTransactionId = overrides.externalId ?? crypto.randomUUID();
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey:
      overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: overrides.reference?.money ?? brl('10.00'),
    referenceExternalTransactionId: overrides.reference?.externalTransactionId,
    createdAt: p.clock.now(),
  });
}

describe('WagerTransactionRepository', () => {
  test('ida e volta de uma transação REJECTED, buscando por id, key e id externo', async () => {
    const loss = newTransaction(Kind.Loss);
    loss.reject(FailureCode.WalletPlayerMismatch, {
      balanceSnapshot: brl('0.00'),
    });
    await p.tm.runInTransaction(() => p.transactions.insert(loss));

    const [byId, byKey, byExternal] = await p.tm.runInTransaction(
      async () =>
        [
          await p.transactions.findById(loss.id),
          await p.transactions.findByIdempotencyKey(loss.idempotencyKey),
          await p.transactions.findByExternalId(
            'provider-a',
            loss.externalTransactionId,
          ),
        ] as const,
    );

    for (const found of [byId, byKey, byExternal]) {
      expect(found?.id).toBe(loss.id);
      expect(found?.status).toBe(Status.Rejected);
      expect(found?.failureCode).toBe(FailureCode.WalletPlayerMismatch);
      expect(found?.balanceSnapshot?.amount).toBe('0.00');
      expect(found?.money.amount).toBe('10.00');
      expect(found?.referenceExternalTransactionId).toBeUndefined();
    }
  });

  test('update grava o ciclo de vida: PENDING_REFERENCE com agenda, depois nova tentativa', async () => {
    const refund = newTransaction(Kind.Refund, {
      reference: newTransaction(Kind.Bet),
    });
    await p.tm.runInTransaction(async () => {
      refund.markPendingReference({
        nextAttemptAt: new Date('2026-01-01T00:00:01Z'),
        expiresAt: new Date('2026-01-01T00:15:00Z'),
      });
      await p.transactions.insert(refund);
    });
    await p.tm.runInTransaction(async () => {
      const loaded = (await p.transactions.findById(refund.id))!;
      loaded.rescheduleReferenceLookup(new Date('2026-01-01T00:00:03Z'));
      await p.transactions.update(loaded);
    });

    const found = (await p.tm.runInTransaction(() =>
      p.transactions.findById(refund.id),
    ))!;
    expect(found.status).toBe(Status.PendingReference);
    expect(found.attempts).toBe(1);
    expect(found.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:03.000Z');
    expect(found.expiresAt?.toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });

  test('a mesma idempotency key gravada duas vezes vira DuplicateWagerTransactionError', async () => {
    const first = newTransaction(Kind.Loss);
    await p.tm.runInTransaction(() => p.transactions.insert(first));
    const twin = newTransaction(Kind.Loss, {
      idempotencyKey: first.idempotencyKey,
    });
    await expect(
      p.tm.runInTransaction(() => p.transactions.insert(twin)),
    ).rejects.toThrow(DuplicateWagerTransactionError);
  });

  test('o mesmo id externo do provedor também é duplicata', async () => {
    const first = newTransaction(Kind.Loss);
    await p.tm.runInTransaction(() => p.transactions.insert(first));
    const twin = newTransaction(Kind.Loss, {
      externalId: first.externalTransactionId,
      idempotencyKey: 'outra-key',
    });
    await expect(
      p.tm.runInTransaction(() => p.transactions.insert(twin)),
    ).rejects.toThrow(DuplicateWagerTransactionError);
  });

  test('hasProcessedReversal devolve false quando não há reversão', async () => {
    expect(
      await p.tm.runInTransaction(() =>
        p.transactions.hasProcessedReversal(crypto.randomUUID()),
      ),
    ).toBe(false);
  });
});

class TestEvent extends IntegrationEvent<{
  amount: string;
  nested: { ok: boolean };
}> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static of(aggregateId: string): TestEvent {
    return new TestEvent({
      eventId: crypto.randomUUID(),
      aggregateId,
      correlationId: 'corr-1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      data: { amount: '25.00', nested: { ok: true } },
    });
  }
}

describe('InboxRepository', () => {
  test('a primeira gravação registra; a segunda é reconhecida como duplicata, sem erro', async () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: HASH,
      receivedAt: p.clock.now(),
    });
    const [first, second] = await p.tm.runInTransaction(
      async () =>
        [
          await p.inbox.tryRegister(message),
          await p.inbox.tryRegister(message), // mesma transação: o ON CONFLICT não aborta nada
        ] as const,
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test('markProcessed grava processedAt', async () => {
    const message = InboxMessage.receive({
      messageId: 'msg-2',
      consumerName: 'wager-transactions',
      payloadHash: HASH,
      receivedAt: p.clock.now(),
    });
    await p.tm.runInTransaction(async () => {
      await p.inbox.tryRegister(message);
      message.markProcessed(p.clock.now());
      await p.inbox.markProcessed(message);
    });
    const found = await p.tm.runInTransaction(() =>
      p.inbox.find('wager-transactions', 'msg-2'),
    );
    expect(found?.isProcessed()).toBe(true);
  });
});

describe('OutboxRepository', () => {
  test('ida e volta: payload jsonb volta idêntico ao envelope do evento', async () => {
    const event = TestEvent.of(wallet.id);
    await p.tm.runInTransaction(() =>
      p.outbox.enqueue([OutboxMessage.enqueue(event)]),
    );

    const found = (await p.tm.runInTransaction(() =>
      p.outbox.findById(event.eventId),
    ))!;
    expect(found.payload).toEqual(
      event.toJSON() as unknown as Record<string, unknown>,
    );
    expect(found.eventType).toBe('TestEvent');
    expect(found.attempts).toBe(0);
    expect(found.publishedAt).toBeUndefined();
    expect(found.nextAttemptAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('atomicidade entre repositórios', () => {
  test('transação, inbox e outbox gravados juntos somem juntos num rollback', async () => {
    const loss = newTransaction(Kind.Loss);
    const inbox = InboxMessage.receive({
      messageId: 'msg-atomic',
      consumerName: 'wager-transactions',
      payloadHash: HASH,
      receivedAt: p.clock.now(),
    });
    const event = TestEvent.of(wallet.id);

    await expect(
      p.tm.runInTransaction(async () => {
        await p.inbox.tryRegister(inbox);
        await p.transactions.insert(loss);
        await p.outbox.enqueue([OutboxMessage.enqueue(event)]);
        throw new Error('processo morreu antes do commit');
      }),
    ).rejects.toThrow();

    const [tx, msg, out] = await p.tm.runInTransaction(
      async () =>
        [
          await p.transactions.findById(loss.id),
          await p.inbox.find('wager-transactions', 'msg-atomic'),
          await p.outbox.findById(event.eventId),
        ] as const,
    );
    expect([tx, msg, out]).toEqual([undefined, undefined, undefined]);
  });
});
