import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { ErrorMappingFilter } from './platform/http/error-mapping.filter';

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
      ],
      providers: [{ provide: APP_FILTER, useClass: ErrorMappingFilter }],
    };
  }
}
