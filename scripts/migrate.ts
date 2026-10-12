import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

type Command = 'up' | 'down' | 'status' | 'create';
const COMMANDS: readonly Command[] = ['up', 'down', 'status', 'create'];

function parseCommand(raw: string | undefined): Command {
  const command = raw ?? 'status';
  if (!COMMANDS.includes(command as Command)) {
    throw new Error(
      `Comando inválido: "${command}". Use: ${COMMANDS.join(' | ')}`,
    );
  }
  return command as Command;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Variável de ambiente ${name} não definida (confira o .env)`,
    );
  return value;
}

function redact(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}

function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const url = requireEnv('DATABASE_MIGRATION_URL'); // sempre o owner

  console.log(`[migrate] ${command} → ${redact(url)}`);

  const orm = await MikroORM.init({ ...config, clientUrl: url });
  try {
    const migrator = orm.migrator;

    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(
          applied.length
            ? `[migrate] aplicadas: ${applied.map((m) => m.name).join(', ')}`
            : '[migrate] nada a aplicar',
        );
        break;
      }
      case 'down': {
        // sem parâmetro: desfaz só a última migration aplicada
        const reverted = await migrator.down();
        console.log(
          reverted.length
            ? `[migrate] revertidas: ${reverted.map((m) => m.name).join(', ')}`
            : '[migrate] nada a reverter',
        );
        break;
      }
      case 'status': {
        const executed = await migrator.getExecuted();
        const pending = await migrator.getPending();
        console.log(`[migrate] executadas (${executed.length}):`);
        for (const m of executed)
          console.log(`  ✓ ${m.name}  ${formatDate(m.executed_at)}`);
        console.log(`[migrate] pendentes (${pending.length}):`);
        for (const m of pending) console.log(`  • ${m.name}`);
        break;
      }
      case 'create': {
        const name = process.argv[3];
        const result = await migrator.create(undefined, true, false, name); // blank = true
        console.log(`[migrate] criada: ${result.fileName}`);
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(
    '[migrate] falhou:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
