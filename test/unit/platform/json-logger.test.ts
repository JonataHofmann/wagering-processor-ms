import {
  JsonLogger,
  parseLogLevel,
} from '@/src/platform/observability/json-logger';
import {
  enrichLogContext,
  runWithLogContext,
} from '@/src/platform/observability/log-context';
import { describe, expect, test } from 'bun:test';

import { Logger } from '@nestjs/common';

function capture(level = parseLogLevel('debug')) {
  const lines: Array<Record<string, any>> = [];
  const logger = new JsonLogger({
    level,
    write: (line) => lines.push(JSON.parse(line)),
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  test('one JSON line per event, with level, context and message', () => {
    const { logger, lines } = capture();
    logger.log('started', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'Bootstrap',
      msg: 'started',
      service: 'wagering-processor',
    });
    expect(Number.isNaN(Date.parse(lines[0]!.time))).toBe(false);
  });

  test('object message becomes top-level fields (structured log)', () => {
    const { logger, lines } = capture();
    logger.warn({ event: 'sqs_message_retry', delaySeconds: 2 }, 'SqsConsumer');
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'sqs_message_retry',
      delaySeconds: 2,
      context: 'SqsConsumer',
    });
  });

  test('context fields appear in every line, including ones added later', () => {
    const { logger, lines } = capture();
    runWithLogContext({ correlationId: 'corr-1', requestId: 'req-1' }, () => {
      logger.log('antes');
      enrichLogContext({ transactionId: 'tx-1' });
      logger.log('depois');
    });
    logger.log('fora');

    expect(lines[0]).toMatchObject({
      correlationId: 'corr-1',
      requestId: 'req-1',
    });
    expect(lines[0]!.transactionId).toBeUndefined();
    expect(lines[1]).toMatchObject({
      correlationId: 'corr-1',
      transactionId: 'tx-1',
    });
    expect(lines[2]!.correlationId).toBeUndefined();
  });

  test('nested contexts inherit the fields from the outer context', () => {
    const { logger, lines } = capture();
    runWithLogContext({ sqsMessageId: 'sqs-1' }, () =>
      runWithLogContext({ job: 'x' }, () => logger.log('dentro')),
    );
    expect(lines[0]).toMatchObject({ sqsMessageId: 'sqs-1', job: 'x' });
  });

  test('errors carry name, message and stack', () => {
    const { logger, lines } = capture();
    logger.error(new Error('boom'), 'X');
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'boom',
      err: { name: 'Error', message: 'boom' },
    });
    expect(lines[0]!.err.stack).toContain('boom');
  });

  test('respects the configured level', () => {
    const { logger, lines } = capture(parseLogLevel('warn'));
    logger.log('info some');
    logger.debug('debug some');
    logger.warn('warn passa');
    logger.error('error passa');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  test('accepts the usual level names and rejects invalid ones', () => {
    expect(parseLogLevel('info')).toBe('log');
    expect(parseLogLevel('trace')).toBe('verbose');
    expect(parseLogLevel(undefined)).toBe('log');
    expect(() => parseLogLevel('loud')).toThrow('invalid LOG_LEVEL');
  });

  test('works as the Nest logger: new Logger(context) delegates to it', () => {
    const { logger, lines } = capture();
    Logger.overrideLogger(logger);
    try {
      new Logger('Reconciliation').error({
        event: 'WALLET_LEDGER_DIVERGENCE',
        walletId: 'w-1',
      });
    } finally {
      Logger.overrideLogger(false);
    }
    expect(lines[0]).toMatchObject({
      level: 'error',
      context: 'Reconciliation',
      event: 'WALLET_LEDGER_DIVERGENCE',
      walletId: 'w-1',
    });
  });
});
