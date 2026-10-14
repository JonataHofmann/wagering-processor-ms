/** Hoje só "noop" está implementado. "keycloak" existe no tipo do env só pra dar um erro claro. */
export type AuthMode = 'noop';

export interface AuthConfig {
  mode: AuthMode;
}

/**
 * Lê AUTH_MODE e valida contra NODE_ENV. Sem fallback implícito: AUTH_MODE ausente
 * falha o boot, em vez de a aplicação silenciosamente "decidir" rodar em modo inseguro.
 *
 *  - AUTH_MODE ausente            → erro (precisa ser explícito)
 *  - AUTH_MODE=keycloak           → erro (adapter ainda não existe; ver ARCHITECTURE.md)
 *  - AUTH_MODE=noop, NODE_ENV=production → erro (no-op nunca valida credencial de verdade)
 *  - AUTH_MODE=noop, NODE_ENV=development|test → ok
 *  - qualquer outro valor         → erro
 */
export function authConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const mode = env.AUTH_MODE;
  const nodeEnv = env.NODE_ENV ?? 'development';

  if (mode === undefined) {
    throw new Error(
      'AUTH_MODE must be set explicitly (e.g. "noop") — there is no implicit default.',
    );
  }
  if (mode === 'keycloak') {
    throw new Error(
      'AUTH_MODE=keycloak is configured, but the Keycloak adapter is not implemented yet. ' +
        'See ARCHITECTURE.md for the planned integration.',
    );
  }
  if (mode !== 'noop') {
    throw new Error(`unsupported AUTH_MODE: "${mode}" (implemented: "noop")`);
  }
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `AUTH_MODE=noop is not allowed when NODE_ENV="${nodeEnv}" — ` +
        'the no-op adapter never validates credentials and must never run in production.',
    );
  }
  return { mode: 'noop' };
}
