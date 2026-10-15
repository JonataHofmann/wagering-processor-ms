import { type AppProcess, startAppProcess } from './app-process';
import type { RequestFn } from './wagering-client';

/**
 * A set of application instances that can be killed and brought back up mid-load,
 * with an HTTP client that behaves like a real provider: if the instance dies mid-
 * request (or responds 5xx), it resends THE SAME request to another instance.
 */
export class Cluster {
  private instances: AppProcess[] = [];
  private next = 0;
  /** how many times the client had to resend a request */
  retries = 0;

  constructor(
    private readonly databaseUrl: string,
    private readonly env: Record<string, string>,
  ) {}

  get size(): number {
    return this.instances.length;
  }

  async start(count: number): Promise<void> {
    const started = await Promise.all(
      Array.from({ length: count }, () =>
        startAppProcess(this.databaseUrl, this.env),
      ),
    );
    this.instances.push(...started);
  }

  /** SIGKILL: abrupt death, no shutdown hook runs. */
  async kill(index: number): Promise<AppProcess> {
    const [victim] = this.instances.splice(index, 1);
    await victim!.kill();
    return victim!;
  }

  /** SIGTERM: ordered shutdown (finishes work in progress). */
  async terminate(index: number): Promise<AppProcess> {
    const [victim] = this.instances.splice(index, 1);
    await victim!.stop();
    return victim!;
  }

  async killAll(): Promise<void> {
    const victims = this.instances.splice(0);
    await Promise.all(victims.map((v) => v.kill()));
  }

  async stopAll(): Promise<void> {
    const all = this.instances.splice(0);
    await Promise.all(all.map((p) => p.stop()));
  }

  /** Client with failover: resends the same request until it gets a definitive response. */
  readonly request: RequestFn = async (path, init) => {
    const deadline = Date.now() + 60_000;
    for (let attempt = 1; ; attempt++) {
      const target = this.pick();
      if (target !== undefined) {
        try {
          const response = await target.request(path, init);
          if (response.status < 500) return response;
          await response.body?.cancel();
        } catch {
          // connection refused or dropped mid-request: the instance died
        }
      }
      if (Date.now() > deadline)
        throw new Error(
          `${init?.method ?? 'GET'} ${path}: no definitive answer within 60 s`,
        );
      this.retries += 1;
      await Bun.sleep(Math.min(100 * attempt, 500));
    }
  };

  private pick(): AppProcess | undefined {
    if (this.instances.length === 0) return undefined;
    this.next = (this.next + 1) % this.instances.length;
    return this.instances[this.next];
  }
}
