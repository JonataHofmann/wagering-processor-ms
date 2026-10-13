import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Campos que identificam "de onde veio" o que está sendo logado. Ficam num AsyncLocalStorage:
 * todo log emitido durante uma requisição, uma mensagem ou uma rodada de worker os carrega
 * automaticamente, sem passar nada de função em função.
 */
export interface LogContext {
  correlationId?: string;
  requestId?: string;
  /** messageId do envelope (o do provedor) */
  messageId?: string;
  /** MessageId atribuído pelo SQS */
  sqsMessageId?: string;
  walletId?: string;
  transactionId?: string;
  /** worker em execução: outbox-relay, pending-reference */
  job?: string;
  [field: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `fn` com um contexto novo, herdando os campos do contexto atual (se houver). */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return storage.getStore();
}

/** Acrescenta campos ao contexto atual (ex.: o transactionId, assim que ele existe). */
export function enrichLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store !== undefined) Object.assign(store, fields);
}
