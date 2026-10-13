import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { AppRole } from '@/src/config/app-roles';
import { SqsPollingConsumer } from '@/src/modules/messaging/infrastructure/sqs/sqs-polling-consumer';
import { SqsConfig } from '@/src/modules/messaging/infrastructure/sqs/sqs.config';
import { WagerMessageHandler } from '@/src/modules/wagering/infrastructure/sqs/wager-message.handler';
import type { SQSClient } from '@aws-sdk/client-sqs';

/**
 * Liga a fila wager-transactions.fifo ao WagerMessageHandler, só nas instâncias com o papel "consumer".
 * Para no beforeApplicationShutdown: antes de o pool do banco ser fechado (onApplicationShutdown).
 */
export class WagerTransactionsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private consumer: SqsPollingConsumer | undefined;

  constructor(
    private readonly roles: ReadonlySet<AppRole>,
    private readonly handler: WagerMessageHandler,
    private readonly client: SQSClient | undefined,
    private readonly config: SqsConfig | undefined,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.roles.has('consumer')) return;
    if (this.client === undefined || this.config === undefined) {
      throw new Error('the "consumer" role requires SQS configuration');
    }
    this.consumer = new SqsPollingConsumer(this.client, {
      name: 'wager-transactions',
      queueName: this.config.queues.wagerTransactions,
      deadLetterQueueName: this.config.queues.wagerTransactionsDlq,
      waitTimeSeconds: this.config.consumer.waitTimeSeconds,
      maxReceiveCount: this.config.consumer.maxReceiveCount,
      shutdownTimeoutMs: this.config.consumer.shutdownTimeoutMs,
      handle: (body) => this.handler.handle(body),
    });
    await this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
