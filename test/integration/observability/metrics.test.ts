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
  test('expõe, em formato Prometheus, as métricas produzidas pelo tráfego normal', async () => {
    const { wallet } = await api.openWallet('100.00');
    const op = {
      kind: 'BET' as const,
      amount: '10.00',
      externalId: crypto.randomUUID(),
    };
    await api.submit(wallet, op); // wagering_transactions_total{status=PROCESSED}
    await api.submit(wallet, op); // mesma key+payload -> replay: wagering_duplicates_detected_total
    await t.request(`/wallets/${wallet.walletId}/reconciliation`, {
      method: 'POST',
    }); // wallet_reconciliation_checks_total

    const response = await t.request('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();

    // transações por status
    expect(text).toContain('# TYPE wagering_transactions_total counter');
    expect(text).toMatch(/wagering_transactions_total\{[^}]*status="PROCESSED"[^}]*\} \d/);

    // duplicatas detectadas (idempotência)
    expect(text).toContain('# TYPE wagering_duplicates_detected_total counter');
    expect(text).toMatch(
      /wagering_duplicates_detected_total\{[^}]*source="idempotency_key"[^}]*\} \d/,
    );

    // reconciliação (métrica preexistente, continua funcionando com o snapshot novo)
    expect(text).toContain('# TYPE wallet_reconciliation_checks_total counter');

    // latência HTTP: histograma com buckets cumulativos até +Inf, soma e contagem
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*le="\+Inf"\} \d/);
    expect(text).toContain('http_request_duration_seconds_sum');
    expect(text).toContain('http_request_duration_seconds_count');
  });
});
