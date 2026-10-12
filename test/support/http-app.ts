import { AppModule } from '@/src/app.module';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
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
export async function startTestApp(): Promise<TestApp> {
  const db = await createIsolatedDatabase();
  const app = await NestFactory.create(
    AppModule.register({ databaseUrl: db.appUrl }),
    { logger: false },
  );
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
      await db.drop();
    },
  };
}
