import 'reflect-metadata';

import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  logger.log(
    `HTTP listening on :${port} )`,
  );
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
