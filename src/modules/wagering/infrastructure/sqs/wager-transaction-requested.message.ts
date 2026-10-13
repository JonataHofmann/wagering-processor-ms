import {
  CanonicalValue,
  canonicalHash,
} from '@/src/shared/application/canonical-hash';

import { ProcessWagerTransactionCommand } from '@/src/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { RequestParser } from '@/src/platform/http/request-parsing';
import { RequestValidationError } from '@/src/shared/application/application-errors';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';
const KINDS = Object.values(WagerTransactionKind);

/** Mensagem que nunca vai ser processável como está: vai para a DLQ, sem retry. */
export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

export interface ParsedWagerMessage {
  messageId: string;
  /** hash do conteúdo da mensagem (type + data), para detectar messageId reutilizado */
  payloadHash: string;
  command: ProcessWagerTransactionCommand;
}

/**
 * Lê o envelope do enunciado:
 * { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...operação } }
 */
export function parseWagerTransactionRequested(
  rawBody: string,
): ParsedWagerMessage {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new InvalidMessageError('message body is not valid JSON');
  }

  try {
    const envelope = new RequestParser(body);
    envelope.requireObject('');
    const messageId = envelope.string('messageId', { maxLength: 128 });
    const type = envelope.oneOf('type', [WAGER_TRANSACTION_REQUESTED] as const);
    const correlationId = envelope.string('correlationId', {
      required: false,
      maxLength: 128,
    });
    envelope.requireObject('data');
    envelope.assertValid();

    const data = new RequestParser((body as { data: unknown }).data);
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: data.string('idempotencyKey', { maxLength: 255 })!,
      providerId: data.string('providerId', { maxLength: 64 })!,
      externalTransactionId: data.string('externalTransactionId', {
        maxLength: 128,
      })!,
      playerId: data.uuid('playerId')!,
      walletId: data.uuid('walletId')!,
      roundId: data.string('roundId', { maxLength: 128 })!,
      gameId: data.string('gameId', { maxLength: 128 })!,
      kind: data.oneOf('kind', KINDS)!,
      money: {
        amount: data.string('money.amount')!,
        currency: data.string('money.currency')!,
      },
      referenceExternalTransactionId: data.string(
        'referenceExternalTransactionId',
        { required: false, maxLength: 128 },
      ),
      correlationId: correlationId ?? messageId!,
      causationId: messageId!,
    };
    data.assertValid();

    return {
      messageId: messageId!,
      payloadHash: canonicalHash({
        type: type!,
        data: (body as { data: CanonicalValue }).data,
      }),
      command,
    };
  } catch (error) {
    if (error instanceof RequestValidationError) {
      throw new InvalidMessageError(
        `invalid message: ${error.violations.map((v) => `${v.field} ${v.message}`).join('; ')}`,
      );
    }
    throw error;
  }
}
