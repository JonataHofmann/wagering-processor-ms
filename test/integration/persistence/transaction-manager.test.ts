import { Persistence, createPersistence } from '@/test/support/persistence';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sqlStateOf } from '@/src/infrastructure/persistence/pg-error';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { Money } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

let p: Persistence;
beforeAll(async () => {
  p = await createPersistence();
});
afterAll(async () => {
  await p.close();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function newWallet(balance = '0.00') {
  return Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl(balance),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    openedAt: p.clock.now(),
  }).wallet;
}

describe('MikroTransactionManager', () => {
  test('commit: o que foi gravado dentro da transação fica visível depois', async () => {
    const wallet = newWallet();
    await p.tm.runInTransaction(() => p.wallets.insert(wallet));
    const found = await p.tm.runInTransaction(() =>
      p.wallets.findById(wallet.id),
    );
    expect(found?.id).toBe(wallet.id);
  });

  test('rollback: erro dentro da transação desfaz tudo', async () => {
    const wallet = newWallet();
    await expect(
      p.tm.runInTransaction(async () => {
        await p.wallets.insert(wallet);
        throw new Error('falha no meio do caso de uso');
      }),
    ).rejects.toThrow('falha no meio do caso de uso');

    expect(
      await p.tm.runInTransaction(() => p.wallets.findById(wallet.id)),
    ).toBeUndefined();
  });

  test('erro dos triggers deferidos aparece no COMMIT e desfaz tudo', async () => {
    const wallet = newWallet('10.00'); // saldo inicial, mas sem gravar OPENING nem lançamento
    const error = await p.tm
      .runInTransaction(() => p.wallets.insert(wallet))
      .catch((e: unknown) => e);
    expect(sqlStateOf(error)).toBe('WL002');
    expect(
      await p.tm.runInTransaction(() => p.wallets.findById(wallet.id)),
    ).toBeUndefined();
  });

  test('aplica lock_timeout e statement_timeout locais', async () => {
    const settings = await p.tm.runInTransaction(async () =>
      p.context
        .current()
        .execute<Array<{ lock: string; statement: string }>>(
          `SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`,
        ),
    );
    expect(settings[0]).toEqual({ lock: '2s', statement: '5s' });
  });

  test('repositório fora de transação é bug', async () => {
    await expect(p.wallets.findById(crypto.randomUUID())).rejects.toThrow(
      InvariantViolationError,
    );
  });

  test('transação aninhada é bug', async () => {
    await expect(
      p.tm.runInTransaction(() => p.tm.runInTransaction(async () => 1)),
    ).rejects.toThrow(InvariantViolationError);
  });

  test('transações concorrentes usam EntityManagers isolados', async () => {
    const wallets = Array.from({ length: 10 }, () => newWallet());
    await Promise.all(
      wallets.map((w) => p.tm.runInTransaction(() => p.wallets.insert(w))),
    );
    const found = await Promise.all(
      wallets.map((w) => p.tm.runInTransaction(() => p.wallets.findById(w.id))),
    );
    expect(found.every((w, i) => w?.id === wallets[i]!.id)).toBe(true);
  });
});
