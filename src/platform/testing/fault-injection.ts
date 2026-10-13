import { Logger } from '@nestjs/common';

/**
 * Pontos de falha para testes de recuperação (processo morto em momentos críticos).
 * Só age se a variável FAULT_INJECTION tiver exatamente o nome do ponto; em produção
 * a variável não existe e a função não faz nada.
 */
export type FaultPoint =
  | 'crash-after-commit-before-ack'       // consumer SQS: commit feito, ack não
  | 'crash-after-claim-before-publish'    // relay: lote reservado, nada publicado
  | 'crash-after-publish-before-mark';    // relay: publicado no broker, não marcado na outbox

export function faultPoint(point: FaultPoint): void {
  if (process.env.FAULT_INJECTION !== point) return;
  new Logger('FaultInjection').warn(
    `fault injected at "${point}": killing the process with SIGKILL`,
  );
  process.kill(process.pid, 'SIGKILL'); // morte abrupta: nenhum shutdown hook roda
}
