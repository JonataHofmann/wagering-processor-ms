import {
  extractCurrentProvider,
} from '@/src/platform/auth/current-provider.decorator';
import type { ProviderIdentity } from '@/src/platform/auth/provider-identity.port';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, test } from 'bun:test';

function contextWith(providerIdentity?: ProviderIdentity): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => ({ providerIdentity }) as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => undefined as T,
    }),
  } as unknown as ExecutionContext;
}

describe('extractCurrentProvider (CurrentProvider decorator)', () => {
  test('devolve a identidade colocada no request pelo ProviderAuthGuard', () => {
    const identity: ProviderIdentity = {
      subject: 'sub-1',
      providerId: 'provider-1',
      roles: ['provider'],
    };

    expect(extractCurrentProvider(contextWith(identity))).toEqual(identity);
  });

  test('lança se usado sem ProviderAuthGuard (request sem identidade)', () => {
    expect(() => extractCurrentProvider(contextWith(undefined))).toThrow(
      /used without ProviderAuthGuard/,
    );
  });
});
