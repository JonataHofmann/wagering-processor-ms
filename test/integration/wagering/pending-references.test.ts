import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { ResolvePendingReferenceUseCase } from '@/src/modules/wagering/application/resolve-pending-reference.use-case';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import {
  type Operation,
  type TestWallet,
  walletClient,
} from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

// tempos curtos: o teste não espera 15 minutos para provar a expiração
const LOOKUP = { backoffBaseMs: 100, backoffMaxMs: 400, ttlMs: 1_500 };

let t: TestApp;
let api: ReturnType<typeof walletClient>;
let resolver: ResolvePendingReferenceUseCase;
let transactions: WagerTransactionRepository;
let tm: TransactionManager;

beforeAll(async () => {
  t = await startTestApp({ referenceLookup: LOOKUP });
  api = walletClient(t.request);
  resolver = t.app.get(ResolvePendingReferenceUseCase);
  transactions = t.app.get<WagerTransactionRepository>(
    WAGER_TRANSACTION_REPOSITORY,
  );
  tm = t.app.get<TransactionManager>(TRANSACTION_MANAGER);
});

afterAll(async () => {
  if (t) expect(await walletsInconsistentWithLedger(t.db.appUrl)).toEqual([]);
  await t?.close();
});

interface Row {
  id: string;
  status: string;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  reference_transaction_id: string | null;
}

async function rowOf(transactionId: string): Promise<Row> {
  const [row] = await queryOnce<Row>(
    t.db.appUrl,
    `SELECT id, status, failure_code, attempts, next_attempt_at, reference_transaction_id
       FROM wager_transactions WHERE id = $1`,
    [transactionId],
  );
  return row!;
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await queryOnce<{ event_type: string }>(
    t.db.appUrl,
    `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY occurred_at, event_type`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

async function newWallet(balance: string): Promise<TestWallet> {
  return (await api.openWallet(balance)).wallet;
}

/** Envia uma operação que referencia um id externo que ainda não existe. */
async function early(w: TestWallet, op: Operation) {
  const result = await api.submit(w, op);
  expect(result.status).toBe(202);
  expect(result.body.status).toBe('PENDING_REFERENCE');
  return result;
}

describe('resolução de referências fora de ordem', () => {
  test('REFUND antes da BET: reagenda enquanto falta, resolve quando a BET chega', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });

    // a BET ainda não chegou: nova tentativa com backoff, sem evento novo
    expect(await resolver.execute(refund.body.transactionId)).toBe(
      'rescheduled',
    );
    const waiting = await rowOf(refund.body.transactionId);
    expect(waiting.attempts).toBe(1);
    expect(waiting.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    // a BET chega: debita e antecipa a pendência que esperava por ela
    const bet = await api.submit(w, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
    });
    expect(bet.status).toBe(200);
    expect(
      (await rowOf(refund.body.transactionId)).next_attempt_at!.getTime(),
    ).toBeLessThanOrEqual(Date.now());

    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved');
    const resolved = await rowOf(refund.body.transactionId);
    expect(resolved.status).toBe('PROCESSED');
    expect(resolved.reference_transaction_id).toBe(bet.body.transactionId);
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('ROLLBACK de WIN antes do WIN: resolvido como débito quando o WIN chega', async () => {
    const w = await newWallet('10.00');
    const winId = crypto.randomUUID();
    const rollback = await early(w, {
      kind: 'ROLLBACK',
      amount: '30.00',
      reference: winId,
    });

    await api.submit(w, { kind: 'WIN', amount: '30.00', externalId: winId }); // 10 → 40
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'resolved',
    ); // 40 → 10
    expect((await rowOf(rollback.body.transactionId)).status).toBe('PROCESSED');
    expect(await api.balanceOf(w)).toEqual({ amount: '10.00', version: 3 });
  });

  test('a referência chega, mas não combina: resolvido como REJECTED pela política', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });

    await api.submit(w, { kind: 'BET', amount: '25.00', externalId: betId }); // valor diferente
    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved');
    expect(await rowOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'AMOUNT_MISMATCH',
    });
    expect(await eventsOf(refund.body.transactionId)).toContain(
      'WagerTransactionRejected',
    );
  });

  test('prazo esgotado: REJECTED com REFERENCE_NOT_FOUND, evento, e o replay mostra o desfecho', async () => {
    const w = await newWallet('100.00');
    const op: Operation = {
      kind: 'REFUND',
      amount: '40.00',
      reference: crypto.randomUUID(),
      externalId: crypto.randomUUID(),
    };
    const refund = await early(w, op);

    await Bun.sleep(LOOKUP.ttlMs + 100);
    expect(await resolver.execute(refund.body.transactionId)).toBe('expired');
    expect(await rowOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await eventsOf(refund.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);

    // o provedor reenviando a mesma requisição recebe o desfecho final
    const replay = await api.submit(w, op);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: true,
    });
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 1 });
  });

  test('cadeia: ROLLBACK de um REFUND que espera a BET; os dois se resolvem em ordem', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refundId = crypto.randomUUID();

    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
      externalId: refundId,
    });
    // o REFUND existe, mas ainda está pendente: o ROLLBACK espera em vez de ser rejeitado
    const rollback = await early(w, {
      kind: 'ROLLBACK',
      amount: '40.00',
      reference: refundId,
    });

    await api.submit(w, { kind: 'BET', amount: '40.00', externalId: betId }); // 100 → 60
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'rescheduled',
    ); // REFUND ainda pendente
    expect(await resolver.execute(refund.body.transactionId)).toBe('resolved'); // 60 → 100, antecipa o ROLLBACK
    expect(
      (await rowOf(rollback.body.transactionId)).next_attempt_at!.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(await resolver.execute(rollback.body.transactionId)).toBe(
      'resolved',
    ); // 100 → 60

    expect(await api.balanceOf(w)).toEqual({ amount: '60.00', version: 4 });
  });

  test('resoluções simultâneas da mesma pendência: um único efeito', async () => {
    const w = await newWallet('100.00');
    const betId = crypto.randomUUID();
    const refund = await early(w, {
      kind: 'REFUND',
      amount: '40.00',
      reference: betId,
    });
    await api.submit(w, { kind: 'BET', amount: '40.00', externalId: betId });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolver.execute(refund.body.transactionId),
      ),
    );
    expect(outcomes.filter((o) => o === 'resolved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(9);
    expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 3 });
  });

  test('o replay de uma pendência ainda aberta continua 202', async () => {
    const w = await newWallet('100.00');
    const op: Operation = {
      kind: 'REFUND',
      amount: '10.00',
      reference: crypto.randomUUID(),
      externalId: crypto.randomUUID(),
    };
    const first = await early(w, op);
    const replay = await api.submit(w, op);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });
});

describe('reserva de pendências vencidas', () => {
  test('reservas simultâneas pegam conjuntos disjuntos, e o reservado sai da fila até a reserva vencer', async () => {
    // limpa pendências de testes anteriores
    await queryOnce(
      t.db.appUrl,
      `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE status = 'PENDING_REFERENCE'`,
    );

    const w = await newWallet('100.00');
    const pending = await Promise.all(
      Array.from({ length: 12 }, () =>
        early(w, {
          kind: 'REFUND',
          amount: '1.00',
          reference: crypto.randomUUID(),
        }),
      ),
    );
    await Bun.sleep(LOOKUP.backoffBaseMs + 50); // todas vencidas

    const now = new Date();
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        tm.runInTransaction(() =>
          transactions.claimDuePendingReferences({
            now,
            leaseMs: 60_000,
            limit: 5,
          }),
        ),
      ),
    );

    const claimed = claims.flat();
    expect(new Set(claimed).size).toBe(claimed.length); // nenhuma pendência em duas reservas
    expect(new Set(claimed)).toEqual(
      new Set(pending.map((p) => p.body.transactionId)),
    );

    // reservadas: invisíveis até a reserva vencer
    expect(
      await tm.runInTransaction(() =>
        transactions.claimDuePendingReferences({
          now,
          leaseMs: 60_000,
          limit: 50,
        }),
      ),
    ).toEqual([]);
  });
});
