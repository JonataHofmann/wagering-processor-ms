import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    AppModule.register({ databaseUrl: requireEnv('DATABASE_URL') }),
    { bufferLogs: true },
  );
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(
    `HTTP listening on :${port} (roles: ${process.env.APP_ROLES ?? 'none'})`,
  );
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    'Failed to start application',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
