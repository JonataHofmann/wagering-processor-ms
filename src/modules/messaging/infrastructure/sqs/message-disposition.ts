/**
 * Decisão sobre uma mensagem recebida:
 *  ack         → apagar da fila (somente depois do commit)
 *  retry       → devolver à fila com atraso (backoff)
 *  dead-letter → mandar para a DLQ e apagar da fila
 */
export type MessageDisposition =
  | { action: 'ack'; reason: string }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string; detail: string };

export type MessageHandlerFn = (body: string) => Promise<MessageDisposition>;
