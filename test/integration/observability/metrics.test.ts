import { startTestApp, type TestApp } from '@/test/support/http-app';
import { walletClient } from '@/test/support/wagering-client';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let t: TestApp;
let api: ReturnType<typeof walletClient>;

beforeAll(async () => {
  t = await startTestApp();
  api = walletClient(t.request);
});
afterAll(async () => {
  await t?.close();
});

describe('GET /metrics', () => {
  test('exposes, in Prometheus format, the metrics produced by normal traffic', async () => {
    const { wallet } = await api.openWallet('100.00');
    const op = {
      kind: 'BET' as const,
      amount: '10.00',
      externalId: crypto.randomUUID(),
    };
    await api.submit(wallet, op); // wagering_transactions_total{status=PROCESSED}
    await api.submit(wallet, op); // same key+payload -> replay: wagering_duplicates_detected_total
    await t.request(`/wallets/${wallet.walletId}/reconciliation`, {
      method: 'POST',
    }); // wallet_reconciliation_checks_total

    const response = await t.request('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();

    // transactions by status
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toMatch(/wagering_transactions_total\{[^}]*status="PROCESSED"[^}]*\} \d/);

    // duplicates detected (idempotency)
    expect(text).toContain('# TYPE wagering_duplicates_detected_total counter');
    expect(text).toMatch(
      /wagering_duplicates_detected_total\{[^}]*source="idempotency_key"[^}]*\} \d/,
    );

    // reconciliation (pre-existing metric, still works with the new snapshot)
    expect(text).toContain('# TYPE wallet_reconciliation_checks_total counter');

    // HTTP latency: histogram with cumulative buckets up to +Inf, sum and count
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*le="\+Inf"\} \d/);
    expect(text).toContain('http_request_duration_seconds_sum');
    expect(text).toContain('http_request_duration_seconds_count');
  });
});
