import { type AppProcess, startAppProcess } from '@/test/support/app-process';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '@/test/support/database';
import { queryOnce } from '@/test/support/pg';
import {
  consumerEnv,
  createTestQueues,
  type TestQueues,
  waitFor,
} from '@/test/support/sqs';
import { type TestWallet, walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let db: IsolatedDatabase;
let queues: TestQueues;
let app: AppProcess;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  queues = await createTestQueues();
  app = await startAppProcess(db.appUrl, {
    ...consumerEnv(queues),
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'debug',
  });
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await queues?.drop();
  await db?.drop();
}, 60_000);

type LogLine = Record<string, any>;

/** All lines the process wrote, already parsed as JSON. */
function logLines(): LogLine[] {
  return app
    .output()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

function find(predicate: (line: LogLine) => boolean): LogLine | undefined {
  return logLines().find(predicate);
}

async function newWallet(): Promise<TestWallet> {
  return (await walletClient(app.request).openWallet('100.00')).wallet;
}

describe('structured logs', () => {
  describe('structured logs', () => {
    test('every line written by the process is JSON with time, level and service', async () => {
      // the app_started line is written right after listen: it may arrive an instant after the health check
      await waitFor(
        async () => find((l) => l.event === 'app_started') !== undefined,
        'app_started log line',
        5_000,
      );

      const lines = logLines(); // JSON.parse throws if any line is not JSON
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatchObject({ service: 'wagering-processor' });
        expect(typeof line.time).toBe('string');
        expect(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).toContain(
          line.level,
        );
      }
      expect(find((l) => l.event === 'app_started')).toMatchObject({
        context: 'Bootstrap',
      });
    });
  });
});

describe('HTTP correlation', () => {
  test('the received X-Correlation-Id comes back in the response and appears in the access log line', async () => {
    const response = await app.request('/health/live', {
      headers: { 'X-Correlation-Id': 'corr-health-1' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('corr-health-1');

    await waitFor(
      async () =>
        find(
          (l) =>
            l.event === 'http_request' && l.correlationId === 'corr-health-1',
        ) !== undefined,
      'access log line',
      5_000,
    );
    expect(find((l) => l.correlationId === 'corr-health-1')).toMatchObject({
      context: 'HTTP',
      method: 'GET',
      path: '/health/live',
      status: 200,
      level: 'debug',
    });
  });

  test('without a header, a new correlationId is generated and returned', async () => {
    const response = await app.request('/health/live');
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a malformed X-Correlation-Id is replaced with a new one', async () => {
    const response = await app.request('/health/live', {
      headers: { 'X-Correlation-Id': 'tem espaço e ; aspas"' },
    });
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the bet access log line carries walletId and transactionId, and the events carry the same correlationId', async () => {
    const w = await newWallet();
    const { key, body } = walletClient(app.request).payload(w, {
      kind: 'BET',
      amount: '10.00',
    });
    const response = await app.request('/wagering/transactions', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': key, 'X-Correlation-Id': 'corr-bet-1' },
    });
    const result = (await response.json()) as LogLine;

    await waitFor(
      async () =>
        find(
          (l) => l.event === 'http_request' && l.correlationId === 'corr-bet-1',
        ) !== undefined,
      'access log line',
      5_000,
    );
    expect(
      find(
        (l) => l.event === 'http_request' && l.correlationId === 'corr-bet-1',
      ),
    ).toMatchObject({
      level: 'info',
      method: 'POST',
      route: '/wagering/transactions',
      status: 200,
      walletId: w.walletId,
      transactionId: result.transactionId,
    });

    const events = await queryOnce<{ correlation: string }>(
      db.appUrl,
      `SELECT payload->>'correlationId' AS correlation FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1`,
      [result.transactionId],
    );
    expect(events.map((e) => e.correlation)).toEqual([
      'corr-bet-1',
      'corr-bet-1',
    ]);
  });
});

describe('queue correlation', () => {
  test('processing a message logs messageId, correlationId, walletId and transactionId', async () => {
    const w = await newWallet();
    const externalTransactionId = crypto.randomUUID();
    const message = {
      messageId: `msg-${crypto.randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-sqs-1',
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    };
    await queues.send(message, { groupId: w.walletId });

    await waitFor(
      async () =>
        find(
          (l) =>
            l.event === 'sqs_message_acked' &&
            l.messageId === message.messageId,
        ) !== undefined,
      'ack log line',
      15_000,
    );
    const line = find(
      (l) =>
        l.event === 'sqs_message_acked' && l.messageId === message.messageId,
    )!;
    expect(line).toMatchObject({
      correlationId: 'corr-sqs-1',
      walletId: w.walletId,
      receiveCount: 1,
      reason: 'processed',
    });
    expect(line.sqsMessageId).toBeString();
    expect(line.transactionId).toBeString();
  });
});
