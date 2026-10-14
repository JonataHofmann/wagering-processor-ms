import 'reflect-metadata';

import { relayConfigFromEnv } from '@/src/modules/messaging/infrastructure/relay/relay.config';
import { referenceLookupConfigFromEnv } from '@/src/modules/wagering/application/use-cases/reference-lookup.policy';
import { authConfigFromEnv } from '@/src/platform/auth/auth.config';
import { requireEnv } from '@/src/shared/util/require-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { sqsConfigFromEnv } from './modules/messaging/infrastructure/sqs/sqs.config';
import { schedulerConfigFromEnv } from './modules/wagering/infrastructure/scheduler/scheduler.config';
import { createValidationPipe } from './platform/http/validation-pipe';
import {
  JsonLogger,
  type LogLevel,
  parseLogLevel,
} from './platform/observability/json-logger';
const logger = new Logger('Bootstrap');
const ALL_LEVELS: LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];
function createLogger() {
  const level = parseLogLevel(process.env.LOG_LEVEL);
  if ((process.env.LOG_FORMAT ?? 'json') === 'json')
    return new JsonLogger({ level });
  return ALL_LEVELS.slice(0, ALL_LEVELS.indexOf(level) + 1);
}
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    AppModule.register({
      databaseUrl: requireEnv('DATABASE_URL'),
      sqs: sqsConfigFromEnv(),
      relay: relayConfigFromEnv(),
      referenceLookup: referenceLookupConfigFromEnv(),
      scheduler: schedulerConfigFromEnv(),
      auth: authConfigFromEnv(),
    }),
    { bufferLogs: true, logger: createLogger() },
  );
  app.enableShutdownHooks();
  app.useGlobalPipes(createValidationPipe());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Wagering Processor API')
    .setDescription(
      'Processamento de transações de aposta (BET/WIN/LOSS/REFUND/ROLLBACK), wallets e ledger',
    )
    .setVersion('0.0.1')
    .addTag('wagering')
    .addTag('wallets')
    .addTag('health')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log({ event: 'app_started', port });
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
