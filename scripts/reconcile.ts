/**
 * Reconcilia TODAS as wallets: saldo gravado × saldo reconstruído pelo ledger.
 * Somente leitura. Uso: bun run reconcile
 *
 * stdout: uma linha JSON por wallet divergente + uma linha de resumo
 * stderr: logs (divergências também saem como log de erro)
 * exit code: 0 = tudo consistente, 1 = divergência encontrada, 2 = falha ao executar
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import type { AppRole } from '../src/config/app-roles';
import { ReconcileWalletsUseCase } from '../src/modules/wallet/application/reconcile-wallets.use-case';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  // nenhum papel: sem HTTP, sem consumer, sem relay, sem scheduler; só os casos de uso
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ databaseUrl, roles: new Set<AppRole>() }),
    { logger: ['error', 'warn'] },
  );

  try {
    const pageSize = Number(process.env.RECONCILE_PAGE_SIZE ?? 500);
    const result = await app.get(ReconcileWalletsUseCase).reconcileAll(pageSize);
    for (const report of result.divergent) console.log(JSON.stringify(report));
    console.log(JSON.stringify({ checked: result.checked, divergent: result.divergent.length }));
    process.exitCode = result.divergent.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
