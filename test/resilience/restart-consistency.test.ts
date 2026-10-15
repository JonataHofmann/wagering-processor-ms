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
 * Continuous mixed load (HTTP and queue, in order and out of order, with duplicate messages)
 * across 3 instances (every instance does everything), while instances are killed and brought
 * back up:
 *   - one killed with SIGKILL and replaced;
 *   - one shut down with SIGTERM and replaced;
 *   - the WHOLE service killed with SIGKILL and restarted.
 * At the end, the full consistency proof.
 */

const WALLETS = 12;
const INITIAL = 1000;
const OP_SPACING_MS = 250;

let db: IsolatedDatabase;
let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  // short visibility timeout: messages stuck on a dead instance come back quickly;
  // high maxReceiveCount: the test's kills must not send legitimate messages to the DLQ
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
  /** HTTP operations, sent in order (the first is a REFUND before its BET) */
  http: Operation[];
  /** queue messages (sent in order; the ROLLBACK before its WIN; duplicated BETs) */
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
 * Deterministic plan per wallet. No operation can be rejected (balance always has headroom),
 * so the final balance is known up front, regardless of arrival order:
 *   1000 - 5×10 (BETs) + 2×7 (WINs) + 10 (REFUND of BET 1) - 3×5 (BETs via queue) + 20 - 20 (WIN and ROLLBACK)
 *   = 959.00, with 14 entries (opening + 13 movements; LOSS doesn't generate an entry)
 */
function plan(wallet: TestWallet): Planned {
  const bet1 = crypto.randomUUID();
  const winByQueue = crypto.randomUUID();
  const money = (amount: string) => ({ amount, currency: 'BRL' });

  return {
    wallet,
    http: [
      { kind: 'REFUND', amount: '10.00', reference: bet1 }, // before the BET: stays pending
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
      }, // delivered twice
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
      // no operation in the plan can be rejected; 200 or 202 (pending)
      expect([200, 202]).toContain(result.status);
      keys.push(`provider-a:${result.externalId}`);
    }
    const message = p.messages[i];
    if (message !== undefined) {
      for (let copy = 0; copy < message.copies; copy++) {
        await queues.send(message.body, { groupId: p.wallet.walletId }); // new dedup id: SQS delivers the copies
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

test('service restart in the middle of the load: full final consistency', async () => {
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

  // continuous, cheap probe (/health/live, doesn't touch the database) just to guarantee that
  // there's ALWAYS a request in flight at the exact instant of each kill — without this,
  // cluster.retries depends on business traffic coincidentally lining up with the
  // few-ms window of the SIGKILL/SIGTERM, which is visibly flaky.
  let probing = true;
  const probe = (async () => {
    while (probing) {
      try {
        const response = await cluster.request('/health/live');
        await response.text();
      } catch {
        // instance dead during the probe: cluster.request already reroutes
      }
      await Bun.sleep(10);
    }
  })();

  // chaos running in parallel with the load
  const chaos = (async () => {
    await Bun.sleep(600);
    await cluster.kill(0); // 1. one instance suddenly dies (SIGKILL)
    await cluster.start(1); //    and is replaced
    await Bun.sleep(400);
    await cluster.terminate(0); // 2. another is shut down with SIGTERM (deploy)
    await cluster.start(1);
    await Bun.sleep(400);
    await cluster.killAll(); // 3. the whole service goes down (SIGKILL on all)
    await Bun.sleep(300);
    await cluster.start(3); //    and is restarted from scratch
  })();

  const keysPerWallet = await Promise.all(plans.map((p) => runWallet(p, api)));
  await chaos;
  probing = false;
  await probe;
  const allKeys = keysPerWallet.flat();

  // ---------- convergence: the system finishes on its own everything it accepted ----------
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

  // ---------- the proof ----------
  // 1. no effect lost or duplicated: each wallet's final balance is exactly as planned
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

  // 2. one transaction per operation, all terminal, no forgotten pending item
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

  // 3. ledger: exactly one entry per movement, and the balance matches the ledger on every wallet
  expect(await count(`SELECT count(*) AS n FROM wallet_ledger_entries`)).toBe(
    plans.reduce((s, p) => s + p.expectedEntries, 0),
  );
  expect(await walletsInconsistentWithLedger(db.appUrl)).toEqual([]);

  // 4. queue: each message recorded exactly once in the inbox, nothing in the DLQ, nothing left behind in the queue
  expect(await count(`SELECT count(*) AS n FROM inbox_messages`)).toBe(
    sentMessageIds.size,
  );
  expect(await queues.deadLetters()).toHaveLength(0);

  // 5. events: the whole outbox published, and every event reached the broker (duplicates, if any, with the same eventId)
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

  // 6. the official reconciliation (step 17) agrees: exit 0, no divergence
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

  // the chaos really happened: the client had to resend requests (guaranteed by
  // the continuous probe above, not just by coincidence with business load)
  console.log(
    `client retries during chaos: ${cluster.retries}; events published: ${published.length} for ${outboxIds.size} outbox rows`,
  );
  expect(cluster.retries).toBeGreaterThan(0);
}, 180_000);
