import {
  RelayConfig,
  relayConfigFromEnv,
} from '@/src/modules/messaging/infrastructure/relay/relay.config';
import {
  type DynamicModule,
  Global,
  MiddlewareConsumer,
  Module,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { APP_ROLES, type AppRole } from './config/app-roles';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import type { SqsConfig } from './modules/messaging/infrastructure/sqs/sqs.config';
import { MessagingModule } from './modules/messaging/messaging.module';
import {
  REFERENCE_LOOKUP_POLICY,
  type ReferenceLookupConfig,
  referenceLookupConfigFromEnv,
  ReferenceLookupPolicy,
} from '@/src/modules/wagering/application/use-cases/reference-lookup.policy';
import {
  SCHEDULER_CONFIG,
  type SchedulerConfig,
  schedulerConfigFromEnv,
} from './modules/wagering/infrastructure/scheduler/scheduler.config';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { HealthController } from './platform/health/health.controller';
import { ErrorMappingFilter } from './platform/http/error-mapping.filter';

import { HttpMetricsInterceptor } from './platform/observability/http-metrics.interceptor';
import { httpContextMiddleware } from './platform/observability/http-context.middleware';
import { InMemoryMetrics, METRICS } from './platform/observability/metrics';
import { MetricsController } from './platform/observability/metrics.controller';
export interface AppOptions {
  databaseUrl: string;
  debug?: boolean;
  /** papéis desta instância; padrão: só "api" */
  roles?: ReadonlySet<AppRole>;
  /** obrigatório quando a instância tem papéis que usam fila */
  sqs?: SqsConfig;
  /** configuração do relay da outbox; padrão: lote 10, lease 30 s, intervalo 500 ms */
  relay?: RelayConfig;
  referenceLookup?: ReferenceLookupConfig;
  scheduler?: SchedulerConfig;
}

@Global()
@Module({})
class AppConfigModule {
  static forRoot(
    roles: ReadonlySet<AppRole>,
    referenceLookup: ReferenceLookupConfig,
    scheduler: SchedulerConfig,
  ): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [
        { provide: APP_ROLES, useValue: roles },
        {
          provide: REFERENCE_LOOKUP_POLICY,
          useValue: new ReferenceLookupPolicy(referenceLookup),
        },
        { provide: SCHEDULER_CONFIG, useValue: scheduler },
        { provide: METRICS, useValue: new InMemoryMetrics() },
      ],
      exports: [APP_ROLES, REFERENCE_LOOKUP_POLICY, SCHEDULER_CONFIG, METRICS],
    };
  }
}

@Module({})
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(httpContextMiddleware).forRoutes('*');
  }
  /** Recebe a configuração por parâmetro: main.ts passa o .env; os testes passam um banco isolado. */
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(
          options.roles ?? new Set<AppRole>(['api']),
          options.referenceLookup ?? referenceLookupConfigFromEnv({}),
          options.scheduler ?? schedulerConfigFromEnv({}),
        ),
        PersistenceModule.forRoot({
          databaseUrl: options.databaseUrl,
        }),
        MessagingModule.forRoot({
          sqs: options.sqs,
          relay: options.relay ?? relayConfigFromEnv({}),
        }),
        WalletModule,
        WageringModule,
      ],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: APP_FILTER, useClass: ErrorMappingFilter },
        { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
      ],
    };
  }
}
