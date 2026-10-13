import 'reflect-metadata';

import { requireEnv } from '@/src/shared/util/require-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parseAppRoles } from './config/app-roles';
import { sqsConfigFromEnv } from './modules/messaging/infrastructure/sqs/sqs.config';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const roles = parseAppRoles(process.env.APP_ROLES);
  const app = await NestFactory.create(
    AppModule.register({
      databaseUrl: requireEnv('DATABASE_URL'),
      roles,
      sqs: sqsConfigFromEnv(),
    }),
    { bufferLogs: true },
  );
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`HTTP listening on :${port} (roles: ${[...roles].join(',')})`);
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
