import { authConfigFromEnv } from '@/src/platform/auth/auth.config';
import { describe, expect, test } from 'bun:test';

describe('authConfigFromEnv', () => {
  test('AUTH_MODE=noop em development: ok', () => {
    expect(
      authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'development' }),
    ).toEqual({ mode: 'noop' });
  });

  test('AUTH_MODE=noop em test: ok', () => {
    expect(authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'test' })).toEqual({
      mode: 'noop',
    });
  });

  test('AUTH_MODE ausente: falha (sem fallback implícito)', () => {
    expect(() => authConfigFromEnv({})).toThrow(/AUTH_MODE must be set/);
  });

  test('AUTH_MODE=noop em produção: falha', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'noop', NODE_ENV: 'production' }),
    ).toThrow(/not allowed when NODE_ENV="production"/);
  });

  test('AUTH_MODE=keycloak: falha com mensagem explicando que não está implementado', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'keycloak', NODE_ENV: 'development' }),
    ).toThrow(/not implemented yet/);
  });

  test('AUTH_MODE desconhecido: falha', () => {
    expect(() =>
      authConfigFromEnv({ AUTH_MODE: 'basic', NODE_ENV: 'development' }),
    ).toThrow(/unsupported AUTH_MODE/);
  });
});
