import {
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '@/src/platform/auth/provider-identity.port';
import { ProviderAuthGuard } from '@/src/platform/auth/provider-auth.guard';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, test } from 'bun:test';

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  providerIdentity?: ProviderIdentity;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => undefined as T,
    }),
  } as unknown as ExecutionContext;
}

const IDENTITY: ProviderIdentity = {
  subject: 'sub-1',
  providerId: 'provider-1',
  roles: ['provider'],
};

describe('ProviderAuthGuard', () => {
  test('delega ao Port o token extraído do header Authorization: Bearer', async () => {
    let receivedToken: string | undefined;
    const port: ProviderIdentityPort = {
      authenticate: async (token) => {
        receivedToken = token;
        return IDENTITY;
      },
    };
    const guard = new ProviderAuthGuard(port);
    const request: FakeRequest = { headers: { authorization: 'Bearer abc123' } };

    const allowed = await guard.canActivate(contextFor(request));

    expect(allowed).toBe(true);
    expect(receivedToken).toBe('abc123');
  });

  test('disponibiliza a identidade autenticada no contexto da requisição', async () => {
    const port: ProviderIdentityPort = { authenticate: async () => IDENTITY };
    const guard = new ProviderAuthGuard(port);
    const request: FakeRequest = { headers: {} };

    await guard.canActivate(contextFor(request));

    expect(request.providerIdentity).toEqual(IDENTITY);
  });

  test('sem header Authorization, chama o Port com token undefined', async () => {
    let receivedToken: string | undefined = 'nunca-deveria-ficar-assim';
    const port: ProviderIdentityPort = {
      authenticate: async (token) => {
        receivedToken = token;
        return IDENTITY;
      },
    };
    const guard = new ProviderAuthGuard(port);

    await guard.canActivate(contextFor({ headers: {} }));

    expect(receivedToken).toBeUndefined();
  });

  test('rejeita com UnauthorizedException quando o Port lança', async () => {
    const port: ProviderIdentityPort = {
      authenticate: async () => {
        throw new Error('invalid token');
      },
    };
    const guard = new ProviderAuthGuard(port);

    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
