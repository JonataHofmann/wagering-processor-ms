import { authConfigFromEnv } from '@/src/platform/auth/auth.config';
import { describe, expect, test } from 'bun:test';

describe('authConfigFromEnv', () => {
  test('AUTH_MODE=noop in development: ok', () => {
    expect(
      authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'development' }),
    ).toEqual({ mode: 'noop' });
  });

  test('AUTH_MODE=noop in test: ok', () => {
    expect(authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'test' })).toEqual({
      mode: 'noop',
    });
  });

  test('AUTH_MODE missing: fails (no implicit fallback)', () => {
    expect(() => authConfigFromEnv({})).toThrow(/AUTH_MODE must be set/);
  });

  test('AUTH_MODE=noop in production: fails', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'production' }),
    ).toThrow(/not allowed when NODE_ENV="production"/);
  });

  test('AUTH_MODE=keycloak: fails with a message explaining it is not implemented', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'keycloak', NODE_ENV: 'development' }),
    ).toThrow(/not implemented yet/);
  });

  test('unknown AUTH_MODE: fails', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'basic', NODE_ENV: 'development' }),
    ).toThrow(/unsupported AUTH_MODE/);
  });
});
