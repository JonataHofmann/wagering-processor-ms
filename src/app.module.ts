import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { APP_ROLES, type AppRole } from './config/app-roles';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import type { SqsConfig } from './modules/messaging/infrastructure/sqs/sqs.config';
import { MessagingModule } from './modules/messaging/messaging.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { HealthController } from './platform/health/health.controller';
import { ErrorMappingFilter } from './platform/http/error-mapping.filter';

export interface AppOptions {
  databaseUrl: string;
  debug?: boolean;
  /** papéis desta instância; padrão: só "api" */
  roles?: ReadonlySet<AppRole>;
  /** obrigatório quando a instância tem papéis que usam fila */
  sqs?: SqsConfig;
}

@Global()
@Module({})
class AppConfigModule {
  static forRoot(roles: ReadonlySet<AppRole>): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_ROLES, useValue: roles }],
      exports: [APP_ROLES],
    };
  }
}

@Module({})
export class AppModule {
  /** Recebe a configuração por parâmetro: main.ts passa o .env; os testes passam um banco isolado. */
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(options.roles ?? new Set<AppRole>(['api'])),
        PersistenceModule.forRoot({
          databaseUrl: options.databaseUrl,
        }),
        MessagingModule.forRoot(options.sqs),
        WalletModule,
        WageringModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ErrorMappingFilter }],
    };
  }
}
