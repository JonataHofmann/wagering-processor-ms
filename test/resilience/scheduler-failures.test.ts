import { type AppProcess, startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { walletsInconsistentWithLedger } from '@/test/support/invariants';
import { queryOnce } from '@/test/support/pg';
import { schedulerEnv, waitFor } from '@/test/support/sqs';
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
let apiProcess: AppProcess; // só API: cria as pendências e as referências, não resolve nada
let api: ReturnType<typeof walletClient>;
const cleanup: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  db = await createIsolatedDatabase();
  // primeira tentativa só em 5 s: nenhuma pendência vence sozinha durante o teste;
  // quem a torna vencida é o atalho, quando a referência chega
  apiProcess = await startAppProcess(db.appUrl, {
    PENDING_REFERENCE_BACKOFF_BASE_MS: '5000',
  });
  api = walletClient(apiProcess.request);
}, 60_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  if (db) expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);
  await apiProcess?.stop();
  await db?.drop();
}, 60_000);

beforeEach(async () => {
  // pendências que sobraram de um teste anterior não podem derrubar o scheduler do teste seguinte
  await queryOnce(
    db.appUrl,
    `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE status = 'PENDING_REFERENCE'`,
  );
});

function track(process: AppProcess): AppProcess {
  cleanup.push(() => process.stop());
  return process;
}

async function statusOf(
  transactionId: string,
): Promise<{ status: string; next_attempt_at: Date | null }> {
  const [row] = await queryOnce<{
    status: string;
    next_attempt_at: Date | null;
  }>(
    db.appUrl,
    `SELECT status, next_attempt_at FROM wager_transactions WHERE id = $1`,
    [transactionId],
  );
  return row!;
}

/** Wallet com um REFUND pendente; devolve o id externo da BET que ele espera. */
async function pendingRefund(w: TestWallet, amount = '10.00') {
  const betId = crypto.randomUUID();
  const refund = await api.submit(w, {
    kind: 'REFUND',
    amount,
    reference: betId,
  });
  expect(refund.status).toBe(202);
  return { refundId: refund.body.transactionId as string, betId };
}

describe('recuperação do scheduler', () => {
  test('scheduler morto depois de reservar: outra instância resolve quando a reserva vence', async () => {
    // regra da etapa 15: o processo com falha sobe ANTES de existir o trabalho que o derruba
    const doomed = track(
      await startAppProcess(
        db.appUrl,
        schedulerEnv({ FAULT_INJECTION: 'crash-after-claim-before-resolve' }),
      ),
    );

    const { wallet } = await api.openWallet('100.00');
    const { refundId, betId } = await pendingRefund(wallet, '40.00');
    await api.submit(wallet, {
      kind: 'BET',
      amount: '40.00',
      externalId: betId,
    }); // atalho: a pendência vence agora

    await Promise.race([doomed.exited, Bun.sleep(15_000)]);
    expect(doomed.signalCode()).toBe('SIGKILL');

    // reservada pelo processo morto: ainda pendente, com a reserva valendo
    const reserved = await statusOf(refundId);
    expect(reserved.status).toBe('PENDING_REFERENCE');
    expect(reserved.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());

    const survivor = track(await startAppProcess(db.appUrl, schedulerEnv()));
    await waitFor(
      async () => (await statusOf(refundId)).status === 'PROCESSED',
      'resolved after lease',
      20_000,
    );
    await survivor.stop();

    expect(await api.balanceOf(wallet)).toEqual({
      amount: '100.00',
      version: 3,
    });
  }, 60_000);

  test('3 schedulers em processos separados: 30 pendências, cada uma resolvida exatamente uma vez', async () => {
    const schedulers = await Promise.all(
      Array.from({ length: 3 }, () =>
        startAppProcess(db.appUrl, schedulerEnv()),
      ),
    );
    schedulers.forEach(track);

    // 10 wallets com 3 REFUNDs pendentes cada (pendências da mesma wallet disputam o mesmo lock)
    const wallets = await Promise.all(
      Array.from(
        { length: 10 },
        async () => (await api.openWallet('100.00')).wallet,
      ),
    );
    const pendings = (
      await Promise.all(
        wallets.map(async (w) => {
          const items = [];
          for (let i = 0; i < 3; i++)
            items.push({ wallet: w, ...(await pendingRefund(w, '10.00')) });
          return items;
        }),
      )
    ).flat();

    // as BETs chegam todas de uma vez: 30 pendências vencem juntas
    await Promise.all(
      pendings.map((p) =>
        api.submit(p.wallet, {
          kind: 'BET',
          amount: '10.00',
          externalId: p.betId,
        }),
      ),
    );

    await waitFor(
      async () => {
        const [row] = await queryOnce<{ n: string }>(
          db.appUrl,
          `SELECT count(*) AS n FROM wager_transactions WHERE id = ANY($1::uuid[]) AND status = 'PROCESSED'`,
          [pendings.map((p) => p.refundId)],
        );
        return Number(row!.n) === 30;
      },
      'all 30 resolved',
      30_000,
    );
    await Promise.all(schedulers.map((s) => s.stop()));

    // cada REFUND creditou uma única vez: 100 - 3×10 (BETs) + 3×10 (REFUNDs) = 100
    for (const w of wallets) {
      expect(await api.balanceOf(w)).toEqual({ amount: '100.00', version: 7 });
    }
    const [credits] = await queryOnce<{ n: string }>(
      db.appUrl,
      `SELECT count(*) AS n FROM wallet_ledger_entries WHERE transaction_id = ANY($1::uuid[])`,
      [pendings.map((p) => p.refundId)],
    );
    expect(credits!.n).toBe('30');
  }, 90_000);
});
