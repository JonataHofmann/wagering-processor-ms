import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { queryOnce } from '../../support/pg';
import { startTestApp, type TestApp } from '../../support/http-app';
import { walletClient } from '../../support/wagering-client';

let t: TestApp;

beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t?.close(); });

/** Runs `bun scripts/reconcile.ts` against the test database, as an operator would. */
async function runCommand(): Promise<{ exitCode: number; lines: Array<Record<string, any>> }> {
  const child = Bun.spawn([process.execPath, 'scripts/reconcile.ts'], {
    env: { ...process.env, DATABASE_URL: t.db.appUrl, MIKRO_ORM_DEBUG: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const lines = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return { exitCode, lines };
}

describe('bun run reconcile', () => {
  test('everything consistent: exit 0 and only the summary line', async () => {
    const api = walletClient(t.request);
    const { wallet } = await api.openWallet('50.00');
    await api.submit(wallet, { kind: 'BET', amount: '10.00' });

    const { exitCode, lines } = await runCommand();
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ divergent: 0 });
    expect(lines[0]!.checked).toBeGreaterThan(0);
  });

  test('with divergence: exit 1, one line per divergent wallet, and nothing is corrected', async () => {
    const { wallet } = await walletClient(t.request).openWallet('80.00');
    await queryOnce(t.db.ownerUrl, `ALTER TABLE wallets DISABLE TRIGGER USER`);
    await queryOnce(t.db.ownerUrl, `UPDATE wallets SET balance = 81 WHERE id = $1`, [wallet.walletId]);
    await queryOnce(t.db.ownerUrl, `ALTER TABLE wallets ENABLE TRIGGER USER`);

    const { exitCode, lines } = await runCommand();
    expect(exitCode).toBe(1);
    expect(lines.find((l) => l.walletId === wallet.walletId)).toMatchObject({
      consistent: false,
      difference: { amount: '1.00', currency: 'BRL' },
    });
    expect(lines.at(-1)).toMatchObject({ divergent: 1 });

    const [row] = await queryOnce<{ balance: string }>(t.db.appUrl, `SELECT round(balance, 2)::text AS balance FROM wallets WHERE id = $1`, [wallet.walletId]);
    expect(row!.balance).toBe('81.00');
  });
});
