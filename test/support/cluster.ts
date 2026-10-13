import { type AppProcess, startAppProcess } from './app-process';
import type { RequestFn } from './wagering-client';

/**
 * Um conjunto de instâncias da aplicação que pode ser derrubado e reerguido no meio de uma carga,
 * com um cliente HTTP que se comporta como um provedor real: se a instância cair no meio da
 * requisição (ou responder 5xx), reenvia A MESMA requisição para outra instância.
 */
export class Cluster {
  private instances: AppProcess[] = [];
  private next = 0;
  /** quantas vezes o cliente precisou reenviar uma requisição */
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

  /** SIGKILL: morte abrupta, nenhum shutdown hook roda. */
  async kill(index: number): Promise<AppProcess> {
    const [victim] = this.instances.splice(index, 1);
    await victim!.kill();
    return victim!;
  }

  /** SIGTERM: shutdown ordenado (termina o trabalho em andamento). */
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

  /** Cliente com failover: reenvia a mesma requisição até receber uma resposta definitiva. */
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
          // conexão recusada ou derrubada no meio: a instância morreu
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
