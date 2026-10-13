import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  SQS_CLIENT,
  SQS_CONFIG,
  type SqsConfig,
  createSqsClient,
} from './infrastructure/sqs/sqs.config';

class SqsClientShutdown implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/** Disponibiliza o cliente e a configuração do SQS. Sem config, nada é registrado (instâncias só de API). */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(config: SqsConfig | undefined): DynamicModule {
    if (config === undefined) return { module: MessagingModule };
    return {
      module: MessagingModule,
      providers: [
        { provide: SQS_CONFIG, useValue: config },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        SqsClientShutdown,
      ],
      exports: [SQS_CONFIG, SQS_CLIENT],
    };
  }
}
