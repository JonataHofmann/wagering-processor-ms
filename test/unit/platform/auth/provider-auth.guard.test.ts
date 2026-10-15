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
  test('delegates to the Port the token extracted from the Authorization: Bearer header', async () => {
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

  test('makes the authenticated identity available in the request context', async () => {
    const port: ProviderIdentityPort = { authenticate: async () => IDENTITY };
    const guard = new ProviderAuthGuard(port);
    const request: FakeRequest = { headers: {} };

    await guard.canActivate(contextFor(request));

    expect(request.providerIdentity).toEqual(IDENTITY);
  });

  test('without an Authorization header, calls the Port with token undefined', async () => {
    let receivedToken: string | undefined = 'should-never-stay-like-this';
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

  test('rejects with UnauthorizedException when the Port throws', async () => {
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
