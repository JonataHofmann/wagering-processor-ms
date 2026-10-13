import type { LoggerService } from '@nestjs/common';
import { currentLogContext } from './log-context';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 1,
  warn: 2,
  log: 3,
  debug: 4,
  verbose: 5,
};
/** Nomes de nível usados na saída (o "log" do Nest vira "info", como em qualquer agregador). */
const OUTPUT_LEVEL: Readonly<Record<LogLevel, string>> = {
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  log: 'info',
  debug: 'debug',
  verbose: 'trace',
};

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? 'log').toLowerCase();
  if (value === 'info') return 'log';
  if (value === 'trace') return 'verbose';
  if (value in SEVERITY) return value as LogLevel;
  throw new Error(
    `invalid LOG_LEVEL: ${raw} (valid: fatal, error, warn, info, debug, trace)`,
  );
}

export interface JsonLoggerOptions {
  level: LogLevel;
  service?: string;
  /** destino de cada linha; padrão: stdout */
  write?: (line: string) => void;
}

/**
 * Logger do Nest que escreve UMA linha JSON por evento:
 *   {"time":"...","level":"info","service":"wagering-processor","context":"HTTP","msg":"...","correlationId":"...",...}
 * Os campos do LogContext (correlationId, walletId, transactionId...) entram em todas as linhas.
 * Uma mensagem objeto vira campos de primeiro nível (log estruturado, não texto a ser "parseado").
 */
export class JsonLogger implements LoggerService {
  private level: LogLevel;
  private readonly write: (line: string) => void;

  constructor(private readonly options: JsonLoggerOptions) {
    this.level = options.level;
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  setLogLevels(levels: LogLevel[]): void {
    // o Nest passa a lista de níveis habilitados; o mais detalhado define o limite
    const mostVerbose = levels.reduce<LogLevel>(
      (acc, l) => (SEVERITY[l] > SEVERITY[acc] ? l : acc),
      'fatal',
    );
    this.level = mostVerbose;
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] > SEVERITY[this.level]) return;

    // convenção do Nest: o último parâmetro string é o contexto (ex.: o nome passado a new Logger('X'))
    const rest = [...params];
    const context =
      typeof rest.at(-1) === 'string' ? (rest.pop() as string) : undefined;

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: OUTPUT_LEVEL[level],
      service: this.options.service ?? 'wagering-processor',
      context,
      ...currentLogContext(),
    };

    if (message instanceof Error) {
      entry.msg = message.message;
      entry.err = {
        name: message.name,
        message: message.message,
        stack: message.stack,
      };
    } else if (typeof message === 'object' && message !== null) {
      Object.assign(entry, message); // log estruturado: os campos sobem para o primeiro nível
    } else {
      entry.msg = String(message);
    }

    for (const param of rest) {
      if (typeof param === 'string')
        entry.detail = param; // ex.: o stack em logger.error(msg, stack)
      else if (param instanceof Error)
        entry.err = {
          name: param.name,
          message: param.message,
          stack: param.stack,
        };
      else if (typeof param === 'object' && param !== null)
        Object.assign(entry, param);
    }

    this.write(
      JSON.stringify(entry, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
