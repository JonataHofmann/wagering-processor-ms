import { Logger } from '@nestjs/common';

/**
 * Pontos de falha para testes de recuperação (processo morto em momentos críticos).
 * Só age se a variável FAULT_INJECTION tiver exatamente o nome do ponto; em produção
 * a variável não existe e a função não faz nada.
 */
export type FaultPoint = 'crash-after-commit-before-ack';

export function faultPoint(point: FaultPoint): void {
  if (process.env.FAULT_INJECTION !== point) return;
  new Logger('FaultInjection').warn(
    `fault injected at "${point}": killing the process with SIGKILL`,
  );
  process.kill(process.pid, 'SIGKILL'); // morte abrupta: nenhum shutdown hook roda
}
