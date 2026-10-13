import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConfig {
  region: string;
  /** LocalStack/MiniStack em desenvolvimento; ausente na AWS real */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  queues: {
    wagerTransactions: string;
    wagerTransactionsDlq: string;
    walletEvents: string;
  };
  consumer: {
    /** long polling: quanto o ReceiveMessage espera por mensagens (0..20 s) */
    waitTimeSeconds: number;
    /** igual ao maxReceiveCount da redrive policy: na última tentativa, a DLQ é explícita */
    maxReceiveCount: number;
    /** tempo máximo para terminar as mensagens em andamento no shutdown */
    shutdownTimeoutMs: number;
  };
}

export const SQS_CONFIG = Symbol('SqsConfig');
export const SQS_CLIENT = Symbol('SqsClient');

export function sqsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SqsConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_ENDPOINT_URL || undefined,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    queues: {
      wagerTransactions: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
      wagerTransactionsDlq: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      walletEvents: env.SQS_EVENTS_QUEUE ?? 'wallet-events.fifo',
    },
    consumer: {
      waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 20),
      maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
      shutdownTimeoutMs: Number(env.SQS_SHUTDOWN_TIMEOUT_MS ?? 20_000),
    },
  };
}

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: config.credentials,
  });
}
