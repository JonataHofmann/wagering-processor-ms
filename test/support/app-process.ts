import type { Subprocess } from 'bun';
import { createServer } from 'node:net';
import type { RequestFn } from './wagering-client';

export interface AppProcess {
  pid: number;
  baseUrl: string;
  request: RequestFn;
  /** resolves when the process exits (for any reason) */
  exited: Promise<void>;
  /** signal that killed the process (e.g. "SIGKILL"), if any */
  signalCode(): string | null;
  /** tail of the process's output (stdout + stderr) */
  output(): string;
  /** SIGTERM and waits for exit (SIGKILL after 10s) */
  stop(): Promise<void>;
  /** immediate SIGKILL, no shutdown */
  kill(): Promise<void>;
}

/** Asks the OS for a free TCP port. */
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

/** Continuously reads the process's output (so the buffer doesn't fill up) and keeps the tail. */
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
      await Bun.sleep(50); // let the last bit of output arrive
      throw new Error(
        `app process exited early with code ${process.exitCode}. Last output:\n${output.text}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // still starting up
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `app at ${baseUrl} did not become live in ${timeoutMs} ms. Last output:\n${output.text}`,
  );
}

/**
 * Starts the real application as a separate PROCESS (bun src/main.ts), with its own
 * connection pool, against the given database. This is what sets this test apart from
 * the single-instance one: nothing is shared in memory between instances.
 */
export async function startAppProcess(
  databaseUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<AppProcess> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const debug = process.env.APP_PROCESS_LOGS === 'true';

  // process.execPath: the same Bun binary running the tests (doesn't depend on PATH)
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    // every instance always consumes/publishes/schedules (no roles) — the caller is
    // responsible for isolating the queue via extraEnv when that matters (see
    // test/support/sqs.ts); without that, it inherits the queue config from the .env environment.
    env: {
      ...process.env,
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
      child.kill('SIGTERM'); // graceful shutdown: closes HTTP and the pool (enableShutdownHooks)
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
