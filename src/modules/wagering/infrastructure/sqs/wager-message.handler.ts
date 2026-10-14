import {
  InboxReceipt,
  ProcessWagerTransactionUseCase,
} from '@/src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import {
  InvalidMessageError,
  parseWagerTransactionRequested,
} from '@/src/modules/wagering/infrastructure/sqs/wager-transaction-requested.message';

import { isTransientDatabaseError } from '@/src/infrastructure/persistence/pg-error';
import { InboxRepository } from '@/src/modules/messaging/application/ports/inbox.repository';
import { TransactionResult } from '@/src/modules/wagering/application/use-cases/transaction-view';
import { DuplicateMessageError } from '@/src/modules/wagering/error/wagering.errors';
import { enrichLogContext } from '@/src/platform/observability/log-context';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { DomainError } from '@/src/shared/error/domain-error';

export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions';

/**
 * O que fazer com a mensagem depois de tentar processá-la:
 *  ack         → apagar da fila (processada, rejeitada por negócio, ou reentrega já vista)
 *  retry       → devolver à fila com backoff (falha transitória ou inesperada)
 *  dead-letter → mandar para a DLQ já (nunca vai dar certo como está)
 */
export type MessageDisposition =
  | {
      action: 'ack';
      reason: 'processed' | 'duplicate';
      result?: TransactionResult;
    }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string; detail: string };

export class WagerMessageHandler {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly transactionManager: TransactionManager,
    private readonly inbox: InboxRepository,
    private readonly consumerName: string = WAGER_TRANSACTIONS_CONSUMER,
  ) {}

  async handle(rawBody: string): Promise<MessageDisposition> {
    let parsed;
    try {
      parsed = parseWagerTransactionRequested(rawBody);
      enrichLogContext({
        messageId: parsed.messageId,
        correlationId: parsed.command.correlationId,
        walletId: parsed.command.walletId,
      });
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        return {
          action: 'dead-letter',
          reason: 'INVALID_MESSAGE',
          detail: error.message,
        };
      }
      throw error;
    }

    const receipt: InboxReceipt = {
      consumerName: this.consumerName,
      messageId: parsed.messageId,
      payloadHash: parsed.payloadHash,
    };

    try {
      // o MESMO caso de uso da API HTTP; a inbox entra na mesma transação do efeito financeiro
      const result = await this.processTransaction.execute(
        parsed.command,
        receipt,
      );
      enrichLogContext({ transactionId: result.transactionId });
      return { action: 'ack', reason: 'processed', result };
    } catch (error) {
      return this.classify(error, receipt);
    }
  }

  private async classify(
    error: unknown,
    receipt: InboxReceipt,
  ): Promise<MessageDisposition> {
    // reentrega: a mensagem já foi processada e confirmada antes
    if (error instanceof DuplicateMessageError) {
      try {
        const seen = await this.transactionManager.runInTransaction(() =>
          this.inbox.find(receipt.consumerName, receipt.messageId),
        );
        if (seen?.matchesPayload(receipt.payloadHash))
          return { action: 'ack', reason: 'duplicate' };
        return {
          action: 'dead-letter',
          reason: 'MESSAGE_ID_REUSED',
          detail: `messageId ${receipt.messageId} was already used with a different payload`,
        };
      } catch (lookupError) {
        return {
          action: 'retry',
          reason: `inbox lookup failed: ${(lookupError as Error).message}`,
        };
      }
    }

    // payload inválido, wallet inexistente, conflito de idempotência: reenviar não muda nada
    if (error instanceof DomainError) {
      return {
        action: 'dead-letter',
        reason: error.code,
        detail: error.message,
      };
    }

    // banco fora, lock_timeout, deadlock: pode dar certo depois
    if (isTransientDatabaseError(error)) {
      return {
        action: 'retry',
        reason: `transient: ${(error as Error).message}`,
      };
    }

    // bug ou erro desconhecido: tenta de novo, limitado pelo maxReceiveCount da fila (depois, DLQ)
    return {
      action: 'retry',
      reason: `unexpected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
