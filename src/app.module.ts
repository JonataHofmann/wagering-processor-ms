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
import { PersistenceModule } from '@/src/infrastructure/persistence/persistence.module';
import type { SqsConfig } from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import { MessagingModule } from '@/src/modules/messaging/messaging.module';
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
} from '@/src/modules/wagering/infrastructure/scheduler/scheduler.config';
import { WageringModule } from '@/src/modules/wagering/wagering.module';
import { WalletModule } from '@/src/modules/wallet/wallet.module';
import { type AuthConfig, authConfigFromEnv } from '@/src/platform/auth/auth.config';
import { AuthModule } from '@/src/platform/auth/auth.module';
import { HealthController } from '@/src/platform/health/health.controller';
import { ErrorMappingFilter } from '@/src/platform/http/error-mapping.filter';

import { HttpMetricsInterceptor } from '@/src/platform/observability/http-metrics.interceptor';
import { httpContextMiddleware } from '@/src/platform/observability/http-context.middleware';
import { InMemoryMetrics, METRICS } from '@/src/platform/observability/metrics';
import { MetricsController } from '@/src/platform/observability/metrics.controller';
export interface AppOptions {
  databaseUrl: string;
  debug?: boolean;
  /** ausente = consumer/relay ficam inertes (nada pra consumir/publicar); scheduler roda sempre */
  sqs?: SqsConfig;
  /** configuração do relay da outbox; padrão: lote 10, lease 30 s, intervalo 500 ms */
  relay?: RelayConfig;
  referenceLookup?: ReferenceLookupConfig;
  scheduler?: SchedulerConfig;
  auth?: AuthConfig;
}

@Global()
@Module({})
class AppConfigModule {
  static forRoot(
    referenceLookup: ReferenceLookupConfig,
    scheduler: SchedulerConfig,
  ): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [
        {
          provide: REFERENCE_LOOKUP_POLICY,
          useValue: new ReferenceLookupPolicy(referenceLookup),
        },
        { provide: SCHEDULER_CONFIG, useValue: scheduler },
        { provide: METRICS, useValue: new InMemoryMetrics() },
      ],
      exports: [REFERENCE_LOOKUP_POLICY, SCHEDULER_CONFIG, METRICS],
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
          options.referenceLookup ?? referenceLookupConfigFromEnv({}),
          options.scheduler ?? schedulerConfigFromEnv({}),
        ),
        // ao contrário dos configs acima, authConfigFromEnv não tem default seguro pra
        // "ambiente vazio" (não existe no-op implícito) — por isso lê o process.env de
        // verdade (.env) quando a chamadora não passa `auth` explicitamente.
        AuthModule.forRoot(options.auth ?? authConfigFromEnv()),
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
