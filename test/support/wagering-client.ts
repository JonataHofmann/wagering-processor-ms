/**
 * Cliente HTTP mínimo da API, para os testes de integração e de concorrência.
 * Recebe uma função `request` (uma instância de teste ou, na etapa 13, várias).
 */
export type Json = Record<string, any>;

export type RequestFn = (
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export interface Operation {
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING' | string;
  amount: string;
  externalId?: string;
  reference?: string;
  roundId?: string;
  currency?: string;
  playerId?: string;
  idempotencyKey?: string;
}

export interface SubmitResult {
  status: number;
  body: Json;
  externalId: string;
}

export function walletClient(request: RequestFn) {
  async function openWallet(
    balance: string,
    options: { currency?: string; playerId?: string } = {},
  ) {
    const playerId = options.playerId ?? crypto.randomUUID();
    const response = await request('/wallets', {
      method: 'POST',
      body: {
        playerId,
        initialBalance: {
          amount: balance,
          currency: options.currency ?? 'BRL',
        },
      },
    });
    const body = (await response.json()) as Json;
    return {
      status: response.status,
      body,
      wallet: { walletId: body.id as string, playerId },
    };
  }

  function payload(w: TestWallet, op: Operation) {
    const externalTransactionId = op.externalId ?? crypto.randomUUID();
    return {
      key: op.idempotencyKey ?? `provider-a:${externalTransactionId}`,
      body: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: op.playerId ?? w.playerId,
        walletId: w.walletId,
        roundId: op.roundId ?? 'round-1',
        gameId: 'fortune-chimp',
        kind: op.kind,
        money: { amount: op.amount, currency: op.currency ?? 'BRL' },
        ...(op.reference !== undefined
          ? { referenceExternalTransactionId: op.reference }
          : {}),
      },
    };
  }

  async function submit(
    w: TestWallet,
    op: Operation,
    via: RequestFn = request,
  ): Promise<SubmitResult> {
    const { key, body } = payload(w, op);
    const response = await via('/wagering/transactions', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': key },
    });
    return {
      status: response.status,
      body: (await response.json()) as Json,
      externalId: body.externalTransactionId,
    };
  }

  async function balanceOf(
    w: TestWallet,
  ): Promise<{ amount: string; version: number }> {
    const body = (await (
      await request(`/wallets/${w.walletId}`)
    ).json()) as Json;
    return { amount: body.balance.amount, version: body.version };
  }

  return { openWallet, payload, submit, balanceOf };
}
