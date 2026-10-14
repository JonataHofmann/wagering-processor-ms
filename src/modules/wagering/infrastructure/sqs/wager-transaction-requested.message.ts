import {
  CanonicalValue,
  canonicalHash,
} from '@/src/shared/util/canonical-hash';

import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { ProcessWagerTransactionCommand } from '@/src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { flattenValidationErrors } from '@/src/shared/util/flatten-validation-errors';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  validateSync,
} from 'class-validator';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

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

class WagerTransactionDataDto {
  @IsString()
  @MaxLength(255)
  idempotencyKey!: string;

  @IsString()
  @MaxLength(64)
  providerId!: string;

  @IsString()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @MaxLength(128)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}

/** Envelope do enunciado: { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...operação } }. */
class WagerTransactionRequestedEnvelopeDto {
  @IsString()
  @MaxLength(128)
  messageId!: string;

  @IsIn([WAGER_TRANSACTION_REQUESTED])
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerTransactionDataDto)
  data!: WagerTransactionDataDto;
}

export function parseWagerTransactionRequested(
  rawBody: string,
): ParsedWagerMessage {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new InvalidMessageError('message body is not valid JSON');
  }

  const envelope = plainToInstance(WagerTransactionRequestedEnvelopeDto, body);
  const errors = validateSync(envelope, { whitelist: true });
  if (errors.length > 0) {
    throw new InvalidMessageError(
      `invalid message: ${flattenValidationErrors(errors)
        .map((v) => `${v.field} ${v.message}`)
        .join('; ')}`,
    );
  }

  const data = envelope.data;
  const command: ProcessWagerTransactionCommand = {
    idempotencyKey: data.idempotencyKey,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: { amount: data.money.amount, currency: data.money.currency },
    referenceExternalTransactionId: data.referenceExternalTransactionId,
    correlationId: envelope.correlationId ?? envelope.messageId,
    causationId: envelope.messageId,
  };

  return {
    messageId: envelope.messageId,
    // hash sobre o payload BRUTO (não o DTO validado), para não mudar o hash se o
    // payload tiver campos extras que o whitelist do DTO ignoraria.
    payloadHash: canonicalHash({
      type: envelope.type,
      data: (body as { data: CanonicalValue }).data,
    }),
    command,
  };
}
