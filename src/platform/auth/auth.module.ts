import type { AuthConfig } from '@/src/platform/auth/auth.config';
import { NoOpProviderIdentityAdapter } from '@/src/platform/auth/no-op-provider-identity.adapter';
import { PROVIDER_IDENTITY_PORT } from '@/src/platform/auth/provider-identity.port';
import { ProviderAuthGuard } from '@/src/platform/auth/provider-auth.guard';
import { type DynamicModule, Global, Module } from '@nestjs/common';

/**
 * Hoje só liga o adapter no-op (ver auth.config.ts). O ponto de extensão pra Keycloak é
 * trocar o `useFactory` abaixo por um KeycloakProviderIdentityAdapter — nada fora deste
 * módulo precisa mudar: o Guard, o decorator CurrentProvider e os controllers conhecem
 * só o ProviderIdentityPort, nunca o adapter concreto.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(config: AuthConfig): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          provide: PROVIDER_IDENTITY_PORT,
          useFactory: () => {
            switch (config.mode) {
              case 'noop':
                return new NoOpProviderIdentityAdapter();
            }
          },
        },
        ProviderAuthGuard,
      ],
      exports: [PROVIDER_IDENTITY_PORT, ProviderAuthGuard],
    };
  }
}
