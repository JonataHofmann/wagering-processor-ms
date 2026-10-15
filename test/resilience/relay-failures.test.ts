import { startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { startTestApp, type TestApp } from '@/test/support/http-app';
import { queryOnce } from '@/test/support/pg';
import {
  consumerEnv,
  createTestQueues,
  relayEnv,
  schedulerEnv,
  type TestQueues,
  waitFor,
} from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

let db: IsolatedDatabase;
// app EM PROCESSO (não um `bun src/main.ts` real): sem `sqs:`, relay/consumer
// ficam inertes sozinhos — só gera eventos na outbox via HTTP, nunca os publica,
// nunca disputa com os processos "relay" reais que cada teste sobe abaixo.
let apiApp: TestApp;
let api: ReturnType<typeof walletClient>;
const cleanup: Array<() => Promise<unknown>> = [];

/**
 * Env de um processo real dedicado ao relay: isola a fila de entrada (o consumer dessa
 * instância roda sempre, sem papel pra desligá-lo) e deixa o scheduler praticamente parado
 * (idleIntervalMs gigante) — sem isso, o scheduler consulta wager_transactions a cada 500 ms
 * em cada processo, disputando conexão/CPU com as duas chamadas HTTP sequenciais de
 * walletWithBet() e alargando a janela em que o relay pode reservar um lote parcial.
 */
function relayProcessEnv(
  queues: TestQueues,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...consumerEnv(queues),
    ...relayEnv(queues, extra),
    ...schedulerEnv({ SCHEDULER_IDLE_INTERVAL_MS: '3600000' }),
  };
}

beforeAll(async () => {
  db = await createIsolatedDatabase();
  apiApp = await startTestApp({}, db);
  api = walletClient(apiApp.request);
}, 60_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  await apiApp?.close();
  await db?.drop();
}, 60_000);

beforeEach(async () => {
  // cada teste começa com a outbox vazia: um teste que falhou no meio não deixa
  // eventos pendentes para os relays do teste seguinte
  await queryOnce(
    db.appUrl,
    `UPDATE outbox_messages SET published_at = now(), locked_until = NULL, locked_by = NULL WHERE published_at IS NULL`,
  );
});

function track<
  T extends { stop?: () => Promise<void>; drop?: () => Promise<void> },
>(resource: T): T {
  cleanup.push(async () => {
    await resource.stop?.();
    await resource.drop?.();
  });
  return resource;
}

interface OutboxRow {
  id: string;
  published_at: Date | null;
  locked_by: string | null;
}

async function outboxOf(walletIds: string[]): Promise<OutboxRow[]> {
  return queryOnce<OutboxRow>(
    db.appUrl,
    `SELECT id, published_at, locked_by FROM outbox_messages WHERE aggregate_id = ANY($1::uuid[]) ORDER BY occurred_at, id`,
    [walletIds],
  );
}

/** Cria a wallet e faz uma aposta: 4 eventos commitados na outbox (abertura + aposta). */
async function walletWithBet(): Promise<TestWallet> {
  const { wallet } = await api.openWallet('100.00');
  await api.submit(wallet, { kind: 'BET', amount: '10.00' });
  return wallet;
}

/** Ids dos eventos recebidos que pertencem às wallets informadas (ignora qualquer outro). */
function eventIdsOf(
  events: Array<{ body: Record<string, any> }>,
  walletIds: string[],
): Set<string> {
  const wallets = new Set(walletIds);
  return new Set(
    events
      .filter((e) => wallets.has(e.body.aggregateId))
      .map((e) => e.body.eventId as string),
  );
}

describe('recuperação do relay', () => {
  test('commit confirmado, relay morre antes de publicar: outra instância assume e publica', async () => {
    const queues: TestQueues = track(await createTestQueues());

    // o relay sobe com a outbox vazia (passa no health check) e fica esperando trabalho.
    // OUTBOX_IDLE_INTERVAL_MS alto (1.5 s) é proposital: abertura e aposta, em walletWithBet(),
    // são 2 transações HTTP sequenciais, não uma só — um idle curto deixaria o relay arriscar
    // pegar o 1º poll bem no meio das duas, reservando só metade do lote (2 de 4 eventos) e
    // morrendo com o resto órfão (criado só depois, sem ninguém pra reservar). Um idle bem
    // maior que o tempo das 2 chamadas garante que a 2ª rodada (não a 1ª, que acha a outbox
    // ainda vazia) sempre encontra o lote inteiro já commitado.
    const doomed = track(
      await startAppProcess(
        db.appUrl,
        relayProcessEnv(queues, {
          FAULT_INJECTION: 'crash-after-claim-before-publish',
          OUTBOX_IDLE_INTERVAL_MS: '1500',
        }),
      ),
    );

    // 1. o PostgreSQL confirma o commit (eventos na outbox)
    const w = await walletWithBet();

    // 2. o relay reserva o lote e morre antes de publicar
    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');

    const reserved = await outboxOf([w.walletId]);
    expect(reserved).toHaveLength(4);
    expect(reserved.every((r) => r.published_at === null)).toBe(true);
    expect(reserved.every((r) => r.locked_by !== null)).toBe(true); // lote preso no lease do relay morto
    expect(eventIdsOf(await queues.drainEvents(), [w.walletId]).size).toBe(0); // nada chegou ao broker

    // 3. outra instância assume quando o lease (2 s) vence, e 4. publica
    const survivor = track(
      await startAppProcess(db.appUrl, relayProcessEnv(queues)),
    );
    await waitFor(
      async () =>
        (await outboxOf([w.walletId])).every((r) => r.published_at !== null),
      'events published',
      20_000,
    );
    await survivor.stop();

    expect(eventIdsOf(await queues.drainEvents(), [w.walletId])).toEqual(
      new Set(reserved.map((r) => r.id)),
    );
  }, 60_000);

  test('relay morre depois de publicar e antes de marcar: a republicação é segura (mesmo eventId)', async () => {
    const queues: TestQueues = track(await createTestQueues());

    const doomed = track(
      await startAppProcess(
        db.appUrl,
        relayProcessEnv(queues, {
          FAULT_INJECTION: 'crash-after-publish-before-mark',
          OUTBOX_IDLE_INTERVAL_MS: '1500', // ver comentário no teste anterior
        }),
      ),
    );
    const w = await walletWithBet();

    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');
    expect(
      (await outboxOf([w.walletId])).every((r) => r.published_at === null),
    ).toBe(true); // publicou, não marcou

    const survivor = track(
      await startAppProcess(db.appUrl, relayProcessEnv(queues)),
    );
    await waitFor(
      async () =>
        (await outboxOf([w.walletId])).every((r) => r.published_at !== null),
      'events marked',
      20_000,
    );
    await survivor.stop();

    // republicado com o mesmo MessageDeduplicationId (= eventId): o SQS FIFO descarta a cópia,
    // e, mesmo que não descartasse, o consumidor deduplicaria pelo eventId
    const events = await queues.drainEvents();
    expect(eventIdsOf(events, [w.walletId])).toEqual(
      new Set((await outboxOf([w.walletId])).map((r) => r.id)),
    );
    expect(events.every((e) => e.deduplicationId === e.body.eventId)).toBe(
      true,
    );
  }, 60_000);

  test('3 relays em processos separados: todos os eventos publicados, nenhum perdido', async () => {
    const queues: TestQueues = track(await createTestQueues());
    const wallets = await Promise.all(
      Array.from({ length: 15 }, () => walletWithBet()),
    ); // 60 eventos
    const walletIds = wallets.map((w) => w.walletId);

    const relays = await Promise.all(
      Array.from({ length: 3 }, () =>
        startAppProcess(db.appUrl, relayProcessEnv(queues)),
      ),
    );
    relays.forEach((r) => track(r));

    const allIds = (await outboxOf(walletIds)).map((r) => r.id);
    expect(allIds).toHaveLength(60);

    await waitFor(
      async () =>
        (await outboxOf(walletIds)).every((r) => r.published_at !== null),
      'all published',
      30_000,
    );
    await Promise.all(relays.map((r) => r.stop()));

    expect(eventIdsOf(await queues.drainEvents(), walletIds)).toEqual(
      new Set(allIds),
    );
  }, 90_000);
});
