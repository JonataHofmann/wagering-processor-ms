import type { Subprocess } from 'bun';
import { createServer } from 'node:net';
import type { RequestFn } from './wagering-client';

export interface AppProcess {
  pid: number;
  baseUrl: string;
  request: RequestFn;
  /** resolve quando o processo termina (por qualquer motivo) */
  exited: Promise<void>;
  /** sinal que matou o processo (ex.: "SIGKILL"), se for o caso */
  signalCode(): string | null;
  /** final da saída (stdout + stderr) do processo */
  output(): string;
  /** SIGTERM e espera terminar (SIGKILL após 10 s) */
  stop(): Promise<void>;
  /** SIGKILL imediato, sem shutdown */
  kill(): Promise<void>;
}

/** Pede ao sistema uma porta TCP livre. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Lê continuamente a saída do processo (para o buffer não encher) e guarda o final. */
function drain(
  stream: ReadableStream<Uint8Array>,
  sink: { text: string },
  echo: boolean,
): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (echo) globalThis.process.stderr.write(text);
      sink.text = (sink.text + text).slice(-500_000);
    }
  })().catch(() => undefined);
}

async function waitUntilLive(
  baseUrl: string,
  process: Subprocess,
  output: { text: string },
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      await Bun.sleep(50); // deixa a última saída chegar
      throw new Error(
        `app process exited early with code ${process.exitCode}. Last output:\n${output.text}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `app at ${baseUrl} did not become live in ${timeoutMs} ms. Last output:\n${output.text}`,
  );
}

/**
 * Sobe a aplicação real como um PROCESSO separado (bun src/main.ts), com seu próprio
 * pool de conexões, contra o banco informado. É o que diferencia este teste do
 * single-instance: nada é compartilhado em memória entre as instâncias.
 */
export async function startAppProcess(
  databaseUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<AppProcess> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const debug = process.env.APP_PROCESS_LOGS === 'true';

  // process.execPath: o mesmo binário do Bun que roda os testes (não depende do PATH)
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    // APP_ROLES=api por padrão: o .env pode ligar o consumer, e o teste não deve consumir a fila de desenvolvimento
    env: {
      ...process.env,
      APP_ROLES: 'api',
      MIKRO_ORM_DEBUG: 'false',
      ...extraEnv,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = { text: '' };
  drain(child.stdout, output, debug);
  drain(child.stderr, output, debug);

  try {
    await waitUntilLive(baseUrl, child, output);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  return {
    pid: child.pid,
    baseUrl,
    exited: child.exited.then(() => undefined),
    signalCode: () =>
      child.signalCode === null || child.signalCode === undefined
        ? null
        : String(child.signalCode),
    output: () => output.text,
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
    async stop() {
      child.kill('SIGTERM'); // shutdown gracioso: fecha HTTP e o pool (enableShutdownHooks)
      const exited = await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => 'timeout' as const),
      ]);
      if (exited === 'timeout') {
        child.kill('SIGKILL');
        await child.exited;
      }
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}
