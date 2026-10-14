import { METRICS, type Metrics } from '@/src/platform/observability/metrics';
import { CLOCK, type Clock } from '@/src/shared/application/ports/clock.port';
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from '@/src/shared/application/ports/transaction-manager.port';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
} from './application/ports/event-publisher.port';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from './application/ports/outbox.repository';
import { OutboxRelayWorker } from './infrastructure/relay/outbox-relay.worker';
import {
  RELAY_CONFIG,
  type RelayConfig,
} from './infrastructure/relay/relay.config';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
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

export interface MessagingOptions {
  /** ausente em instâncias só de API */
  sqs?: SqsConfig;
  relay: RelayConfig;
}

/** Cliente SQS, publicador de eventos e o worker do relay da outbox. */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingOptions): DynamicModule {
    const { sqs } = options;
    const sqsProviders: Provider[] =
      sqs === undefined
        ? []
        : [
            { provide: SQS_CONFIG, useValue: sqs },
            { provide: SQS_CLIENT, useFactory: () => createSqsClient(sqs) },
            {
              provide: EVENT_PUBLISHER,
              useFactory: (client: SQSClient) =>
                new SqsEventPublisher(client, sqs.queues.walletEvents),
              inject: [SQS_CLIENT],
            },
            SqsClientShutdown,
          ];

    return {
      module: MessagingModule,
      providers: [
        ...sqsProviders,
        { provide: RELAY_CONFIG, useValue: options.relay },
        {
          provide: OutboxRelayWorker,
          useFactory: (
            tm: TransactionManager,
            outbox: OutboxRepository,
            publisher: EventPublisher | undefined,
            clock: Clock,
            config: RelayConfig,
            metrics: Metrics,
          ) => new OutboxRelayWorker(tm, outbox, publisher, clock, config, metrics),
          inject: [
            TRANSACTION_MANAGER,
            OUTBOX_REPOSITORY,
            { token: EVENT_PUBLISHER, optional: true },
            CLOCK,
            RELAY_CONFIG,
            METRICS,
          ],
        },
      ],
      exports:
        sqs === undefined ? [] : [SQS_CONFIG, SQS_CLIENT, EVENT_PUBLISHER],
    };
  }
}
