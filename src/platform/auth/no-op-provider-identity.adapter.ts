import type {
  ProviderIdentity,
  ProviderIdentityPort,
} from '@/src/platform/auth/provider-identity.port';

const NOOP_IDENTITY: ProviderIdentity = {
  subject: 'local-service-account',
  providerId: 'development-provider',
  roles: ['provider'],
};

/**
 * IMPLEMENTAÇÃO TEMPORÁRIA. Nunca valida token, nunca consulta Keycloak, nunca faz
 * I/O (rede ou banco), e nunca exige que um token exista — sempre devolve a mesma
 * identidade fictícia determinística. Só pode ser ligada com AUTH_MODE=noop em
 * desenvolvimento/teste (ver auth.config.ts); nunca em produção.
 */
export class NoOpProviderIdentityAdapter implements ProviderIdentityPort {
  async authenticate(_token?: string): Promise<ProviderIdentity> {
    return NOOP_IDENTITY;
  }
}
