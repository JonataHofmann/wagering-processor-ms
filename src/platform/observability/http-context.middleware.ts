import { currentLogContext, runWithLogContext } from './log-context';

import { Logger } from '@nestjs/common';

interface Request {
  method: string;
  originalUrl?: string;
  url: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
}
interface Response {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
}

const CORRELATION_HEADER = 'x-correlation-id';
/** só aceita um correlationId "bem comportado" vindo de fora; senão gera um novo */
const SAFE_ID = /^[\w.:-]{1,128}$/;

const logger = new Logger('HTTP');

/**
 * Abre o contexto de log da requisição:
 * - correlationId: o do header X-Correlation-Id (se válido) ou um novo; devolvido no header da resposta;
 * - requestId: sempre novo (identifica ESTA tentativa, mesmo num reenvio com o mesmo correlationId).
 * Ao terminar, emite uma linha de acesso com método, rota, status e duração.
 */
export function httpContextMiddleware(
  req: Request,
  res: Response,
  next: () => void,
): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const correlationId =
    candidate !== undefined && SAFE_ID.test(candidate)
      ? candidate
      : crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();

  res.setHeader('X-Correlation-Id', correlationId);

  runWithLogContext({ correlationId, requestId }, () => {
    // o MESMO objeto de contexto que o controller vai enriquecer (walletId, transactionId):
    // a linha de acesso, emitida no fim, já sai com esses campos
    const context = currentLogContext() ?? {};
    res.on('finish', () =>
      runWithLogContext(context, () => {
        const path = req.originalUrl ?? req.url;
        const entry = {
          event: 'http_request',
          method: req.method,
          route: req.route?.path,
          path: path.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        };
        if (entry.path?.startsWith('/health')) logger.debug(entry);
        else if (res.statusCode >= 500) logger.error(entry);
        else logger.log(entry);
      }),
    );
    next();
  });
}
