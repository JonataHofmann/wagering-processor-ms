import { PersistenceModule } from '@/src/infrastructure/persistence/persistence.module';
import { WageringModule } from '@/src/modules/wagering/wagering.module';
import { WalletModule } from '@/src/modules/wallet/wallet.module';
import { HealthController } from '@/src/platform/health/health.controller';
import { ErrorMappingFilter } from '@/src/platform/http/error-mapping.filter';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

export interface AppOptions {
  databaseUrl: string;
}

@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PersistenceModule.forRoot({ databaseUrl: options.databaseUrl }),
        WalletModule,
        WageringModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ErrorMappingFilter }],
    };
  }
}
