import { Cluster } from '@/test/support/cluster';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import {
  consumerEnv,
  createTestQueues,
  relayEnv,
  schedulerEnv,
  type TestQueues,
  waitFor,
} from '@/test/support/sqs';
import {
  type Operation,
  type TestWallet,
  walletClient,
} from '@/test/support/wagering-client';
import { afterAll, beforeAll, expect, test } from 'bun:test';

/**
 * Carga mista contínua (HTTP e fila, em ordem e fora de ordem, com mensagens duplicadas)
 * sobre 3 instâncias com todos os papéis, enquanto instâncias são derrubadas e reerguidas:
 *   - uma morta com SIGKILL e substituída;
 *   - uma encerrada com SIGTERM e substituída;
 *   - o serviço INTEIRO morto com SIGKILL e reiniciado.
 * No fim, a prova completa de consistência.
 */

const WALLETS = 12;
const INITIAL = 1000;
const OP_SPACING_MS = 250;

let db: IsolatedDatabase;
let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  // visibility timeout curto: mensagens presas numa instância morta voltam logo;
  // maxReceiveCount alto: as mortes do teste não podem mandar mensagens legítimas para a DLQ
  queues = await createTestQueues({
    visibilityTimeoutSeconds: 3,
    maxReceiveCount: 10,
  });
  cluster = new Cluster(db.appUrl, {
    ...consumerEnv(queues),
    ...relayEnv(queues),
    ...schedulerEnv(),
    SQS_MAX_RECEIVE_COUNT: '10',
  });
  await cluster.start(3);
}, 60_000);

afterAll(async () => {
  await cluster?.stopAll();
  await queues?.drop();
  await db?.drop();
}, 60_000);

// ------------------------------------------------------------------ a carga

interface Planned {
  wallet: TestWallet;
  /** operações HTTP, enviadas em ordem (a primeira é um REFUND antes da sua BET) */
  http: Operation[];
  /** mensagens da fila (enviadas em ordem; o ROLLBACK antes do seu WIN; BETs duplicadas) */
  messages: Array<{ body: Record<string, unknown>; copies: number }>;
  expectedBalance: string;
  expectedEntries: number;
}

function sqsMessage(w: TestWallet, data: Record<string, unknown>) {
  const externalTransactionId =
    (data.externalTransactionId as string | undefined) ?? crypto.randomUUID();
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

/**
 * Plano determinístico por wallet. Nenhuma operação pode ser rejeitada (saldo sempre sobra),
 * então o saldo final é conhecido de antemão, qualquer que seja a ordem de chegada:
 *   1000 - 5×10 (BETs) + 2×7 (WINs) + 10 (REFUND da BET 1) - 3×5 (BETs pela fila) + 20 - 20 (WIN e ROLLBACK)
 *   = 959.00, com 14 lançamentos (abertura + 13 movimentos; LOSS não gera lançamento)
 */
function plan(wallet: TestWallet): Planned {
  const bet1 = crypto.randomUUID();
  const winByQueue = crypto.randomUUID();
  const money = (amount: string) => ({ amount, currency: 'BRL' });

  return {
    wallet,
    http: [
      { kind: 'REFUND', amount: '10.00', reference: bet1 }, // antes da BET: fica pendente
      { kind: 'BET', amount: '10.00', externalId: bet1 },
      { kind: 'BET', amount: '10.00' },
      { kind: 'WIN', amount: '7.00' },
      { kind: 'BET', amount: '10.00' },
      { kind: 'LOSS', amount: '1.00' },
      { kind: 'BET', amount: '10.00' },
      { kind: 'WIN', amount: '7.00' },
      { kind: 'BET', amount: '10.00' },
    ],
    messages: [
      {
        body: sqsMessage(wallet, {
          kind: 'ROLLBACK',
          money: money('20.00'),
          referenceExternalTransactionId: winByQueue,
        }),
        copies: 1,
      },
      {
        body: sqsMessage(wallet, { kind: 'BET', money: money('5.00') }),
        copies: 2,
      }, // entregue duas vezes
      {
        body: sqsMessage(wallet, {
          kind: 'WIN',
          money: money('20.00'),
          externalTransactionId: winByQueue,
        }),
        copies: 1,
      },
      {
        body: sqsMessage(wallet, { kind: 'BET', money: money('5.00') }),
        copies: 2,
      },
      {
        body: sqsMessage(wallet, { kind: 'BET', money: money('5.00') }),
        copies: 2,
      },
    ],
    expectedBalance: '959.00',
    expectedEntries: 14,
  };
}

async function runWallet(
  p: Planned,
  api: ReturnType<typeof walletClient>,
): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < Math.max(p.http.length, p.messages.length); i++) {
    const op = p.http[i];
    if (op !== undefined) {
      const result = await api.submit(p.wallet, op);
      // nenhuma operação do plano pode ser rejeitada; 200 ou 202 (pendente)
      expect([200, 202]).toContain(result.status);
      keys.push(`provider-a:${result.externalId}`);
    }
    const message = p.messages[i];
    if (message !== undefined) {
      for (let copy = 0; copy < message.copies; copy++) {
        await queues.send(message.body, { groupId: p.wallet.walletId }); // dedup id novo: o SQS entrega as cópias
      }
      keys.push(
        (message.body.data as { idempotencyKey: string }).idempotencyKey,
      );
    }
    await Bun.sleep(OP_SPACING_MS);
  }
  return keys;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await queryOnce<{ n: string }>(db.appUrl, sql, params);
  return Number(row!.n);
}

// ------------------------------------------------------------------ o teste

test('reinício do serviço no meio da carga: consistência final completa', async () => {
  const api = walletClient(cluster.request);
  const wallets = await Promise.all(
    Array.from(
      { length: WALLETS },
      async () => (await api.openWallet(`${INITIAL}.00`)).wallet,
    ),
  );
  const plans = wallets.map(plan);
  const sentMessageIds = new Set(
    plans.flatMap((p) =>
      p.messages.map((m) => (m.body as { messageId: string }).messageId),
    ),
  );

  // caos em paralelo com a carga
  const chaos = (async () => {
    await Bun.sleep(600);
    await cluster.kill(0); // 1. uma instância morre de repente (SIGKILL)
    await cluster.start(1); //    e é substituída
    await Bun.sleep(400);
    await cluster.terminate(0); // 2. outra é encerrada com SIGTERM (deploy)
    await cluster.start(1);
    await Bun.sleep(400);
    await cluster.killAll(); // 3. o serviço inteiro cai (SIGKILL em todas)
    await Bun.sleep(300);
    await cluster.start(3); //    e é reiniciado do zero
  })();

  const keysPerWallet = await Promise.all(plans.map((p) => runWallet(p, api)));
  await chaos;
  const allKeys = keysPerWallet.flat();

  // ---------- convergência: o sistema termina sozinho tudo o que aceitou ----------
  await waitFor(
    async () =>
      (await count(
        `SELECT count(*) AS n FROM wager_transactions WHERE idempotency_key = ANY($1) AND status = 'PROCESSED'`,
        [allKeys],
      )) === allKeys.length,
    'every operation processed',
    90_000,
  );
  await waitFor(
    async () => (await queues.depth()) === 0,
    'input queue drained',
    30_000,
  );
  await waitFor(
    async () =>
      (await count(
        `SELECT count(*) AS n FROM outbox_messages WHERE published_at IS NULL`,
      )) === 0,
    'outbox fully published',
    30_000,
  );
  await cluster.stopAll();

  // ---------- a prova ----------
  // 1. nenhum efeito perdido nem duplicado: o saldo final de cada wallet é exatamente o planejado
  for (const p of plans) {
    const [row] = await queryOnce<{ balance: string; version: number }>(
      db.appUrl,
      `SELECT round(balance, 2)::text AS balance, version FROM wallets WHERE id = $1`,
      [p.wallet.walletId],
    );
    expect({ walletId: p.wallet.walletId, ...row }).toEqual({
      walletId: p.wallet.walletId,
      balance: p.expectedBalance,
      version: p.expectedEntries,
    });
  }

  // 2. uma transação por operação, todas terminais, nenhuma pendência esquecida
  expect(
    await count(
      `SELECT count(*) AS n FROM wager_transactions WHERE idempotency_key = ANY($1)`,
      [allKeys],
    ),
  ).toBe(allKeys.length);
  expect(
    await count(
      `SELECT count(*) AS n FROM wager_transactions WHERE status NOT IN ('PROCESSED')`,
    ),
  ).toBe(0);

  // 3. ledger: exatamente um lançamento por movimento, e o saldo bate com o ledger em todas as wallets
  expect(await count(`SELECT count(*) AS n FROM wallet_ledger_entries`)).toBe(
    plans.reduce((s, p) => s + p.expectedEntries, 0),
  );
  expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);

  // 4. fila: cada mensagem registrada uma única vez na inbox, nada na DLQ, nada esquecido na fila
  expect(await count(`SELECT count(*) AS n FROM inbox_messages`)).toBe(
    sentMessageIds.size,
  );
  expect(await queues.deadLetters()).toHaveLength(0);

  // 5. eventos: toda a outbox publicada, e todo evento chegou ao broker (duplicatas, se houver, com o mesmo eventId)
  const outboxIds = new Set(
    (
      await queryOnce<{ id: string }>(
        db.appUrl,
        `SELECT id FROM outbox_messages`,
      )
    ).map((r) => r.id),
  );
  const published = await queues.drainEvents();
  expect(new Set(published.map((e) => e.body.eventId))).toEqual(outboxIds);

  // 6. a reconciliação oficial (etapa 17) concorda: exit 0, nenhuma divergência
  const reconcile = Bun.spawn([process.execPath, 'scripts/reconcile.ts'], {
    env: { ...process.env, DATABASE_URL: db.appUrl, MIKRO_ORM_DEBUG: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [summary, exitCode] = await Promise.all([
    new Response(reconcile.stdout).text(),
    reconcile.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(summary.trim().split('\n').at(-1)!)).toEqual({
    checked: WALLETS,
    divergent: 0,
  });

  // o caos realmente aconteceu: o cliente precisou reenviar requisições
  console.log(
    `client retries during chaos: ${cluster.retries}; events published: ${published.length} for ${outboxIds.size} outbox rows`,
  );
  expect(cluster.retries).toBeGreaterThan(0);
}, 180_000);
