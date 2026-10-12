import { canonicalHash } from '@/src/shared/application/canonical-hash';
import { Money } from '@/src/shared/domain/money';

/** Campos de negócio que identificam o conteúdo de uma operação. */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = SHA-256(JCS(campos de negócio normalizados)).
 * Fora do hash: o header Idempotency-Key e qualquer metadado de transporte
 * (messageId, correlationId, occurredAt). O valor entra na forma canônica ("25.00"),
 * e a referência vazia é tratada como ausente, igual ao domínio.
 */
export function computePayloadHash(fields: PayloadHashFields): string {
  return canonicalHash({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId:
      fields.referenceExternalTransactionId?.trim() || undefined,
  });
}
