import { NoOpProviderIdentityAdapter } from '@/src/platform/auth/no-op-provider-identity.adapter';
import { describe, expect, test } from 'bun:test';

describe('NoOpProviderIdentityAdapter', () => {
  test('devolve sempre a mesma identidade fictícia, com ou sem token', async () => {
    const adapter = new NoOpProviderIdentityAdapter();
    const expected = {
      subject: 'local-service-account',
      providerId: 'development-provider',
      roles: ['provider'],
    };

    expect(await adapter.authenticate()).toEqual(expected);
    expect(await adapter.authenticate('qualquer-coisa')).toEqual(expected);
    expect(await adapter.authenticate('')).toEqual(expected);
  });
});
