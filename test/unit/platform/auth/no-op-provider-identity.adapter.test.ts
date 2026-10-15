import { NoOpProviderIdentityAdapter } from '@/src/platform/auth/no-op-provider-identity.adapter';
import { describe, expect, test } from 'bun:test';

describe('NoOpProviderIdentityAdapter', () => {
  test('always returns the same fake identity, with or without a token', async () => {
    const adapter = new NoOpProviderIdentityAdapter();
    const expected = {
      subject: 'local-service-account',
      providerId: 'development-provider',
      roles: ['provider'],
    };

    expect(await adapter.authenticate()).toEqual(expected);
    expect(await adapter.authenticate('anything')).toEqual(expected);
    expect(await adapter.authenticate('')).toEqual(expected);
  });
});
