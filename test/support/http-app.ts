import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule, type AppOptions } from '../../src/app.module';
import { createValidationPipe } from '../../src/platform/http/validation-pipe';
import { createIsolatedDatabase, type IsolatedDatabase } from './database';

export interface TestApp {
  app: INestApplication;
  db: IsolatedDatabase;
  baseUrl: string;
  /** fetch relativo ao servidor de teste, com JSON por padrão */
  request(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  close(): Promise<void>;
}

/** Sobe a aplicação Nest real numa porta livre, contra um banco isolado, como wagering_app. */

export async function startTestApp(
  options: Omit<AppOptions, 'databaseUrl'> = {},
  /** reaproveita um banco isolado já existente, em vez de criar um novo (e não o derruba no close()) */
  existingDb?: IsolatedDatabase,
): Promise<TestApp> {
  const db = existingDb ?? (await createIsolatedDatabase());
  const app = await NestFactory.create(
    AppModule.register({
      databaseUrl: db.appUrl,
      debug: process.env.MIKRO_ORM_DEBUG === 'true',
      ...options,
    }),
    { logger: process.env.APP_LOGS === 'true' ? undefined : false },
  );
  app.useGlobalPipes(createValidationPipe());
  await app.listen(0);
  const { port } = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    db,
    baseUrl,
    request(path, init = {}) {
      return fetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...init.headers },
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === 'string'
              ? init.body
              : JSON.stringify(init.body),
      });
    },
    async close() {
      await app.close();
      if (existingDb === undefined) await db.drop();
    },
  };
}
