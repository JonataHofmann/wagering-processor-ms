import type { OutboxMessage } from '../../domain/outbox-message';

export interface ClaimRequest {
  /** "agora" segundo o relógio da aplicação (injetável nos testes) */
  now: Date;
  /** por quanto tempo o lote fica reservado para este relay */
  leaseMs: number;
  limit: number;
  /** identificação do relay (instância), para diagnóstico */
  owner: string;
}

export interface OutboxRepository {
  /** Grava os eventos na mesma transação do efeito financeiro. */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;

  /**
   * Reserva um lote de eventos pendentes e vencidos, sem lease ativo, com
   * FOR UPDATE SKIP LOCKED: relays concorrentes nunca pegam o mesmo evento.
   * Em ordem de ocorrência.
   */
  claimDue(request: ClaimRequest): Promise<OutboxMessage[]>;

  /** Marca como publicado e solta o lease. false se já estava publicado. */
  markPublished(message: OutboxMessage): Promise<boolean>;

  /** Grava a tentativa que falhou (attempts, próxima tentativa, erro) e solta o lease. */
  recordFailure(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OutboxRepository');
