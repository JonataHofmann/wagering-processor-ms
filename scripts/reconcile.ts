import 'reflect-metadata';

import { AppModule } from '../src/app.module';
/**
 * Reconcilia TODAS as wallets: saldo gravado × saldo reconstruído pelo ledger.
 * Somente leitura. Uso: bun run reconcile
 *
 * stdout: uma linha JSON por wallet divergente + uma linha de resumo
 * stderr: logs (divergências também saem como log de erro)
 * exit code: 0 = tudo consistente, 1 = divergência encontrada, 2 = falha ao executar
 */
import { NestFactory } from '@nestjs/core';
import { ReconcileWalletsUseCase } from '../src/modules/wallet/application/use-cases/reconcile-wallets.use-case';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  // createApplicationContext: sem HTTP. Sem `sqs`, consumer/relay ficam inertes
  // (nada pra consumir/publicar); o scheduler roda mesmo assim, mas é inofensivo
  // aqui — não encontra nada pendente e para sozinho no app.close() abaixo.
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ databaseUrl }),
    { logger: ['error', 'warn'] },
  );

  try {
    const pageSize = Number(process.env.RECONCILE_PAGE_SIZE ?? 500);
    const result = await app
      .get(ReconcileWalletsUseCase)
      .reconcileAll(pageSize);
    for (const report of result.divergent) console.log(JSON.stringify(report));
    console.log(
      JSON.stringify({
        checked: result.checked,
        divergent: result.divergent.length,
      }),
    );
    process.exitCode = result.divergent.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
