import type {
  EventContext,
  IntegrationEvent,
} from '@/src/shared/domain/integration-event';

import { OutboxMessage } from '@/src/modules/messaging/domain/entities/outbox-message';
import { WagerTransactionProcessed } from '@/src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '@/src/modules/wagering/domain/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '@/src/modules/wagering/domain/events/wallet-balance-changed.event';
import { evaluateReference } from '@/src/modules/wagering/domain/reference-policy';
import type { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import type { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import type { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';
import type { IdGenerator } from '@/src/shared/application/ports/id-generator.port';
import { WagerTransactionPendingReference } from '@/src/modules/wagering/domain/events/wager-transaction-pending-reference.event';
import type { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';

export interface EventCorrelation {
  correlationId: string;
  causationId?: string;
}

/**
 * Decisão de negócio de uma transação, sob o lock da wallet.
 * Compartilhada por quem processa a transação pela primeira vez (HTTP e SQS)
 * e por quem reprocessa uma pendência (scheduler): as regras são as mesmas.
 */
export class WagerSettlement {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Aplica as regras e muda o estado da transação (e da wallet, se houver movimento).
   * Devolve o lançamento quando o saldo mudou.
   * Se a referência não estiver disponível (ausente ou ela mesma pendente), chama
   * `whenReferenceUnavailable`, que decide entre esperar, reagendar ou expirar.
   */
  async decide(
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    whenReferenceUnavailable: () => void,
  ): Promise<WalletLedgerEntry | undefined> {
    const observed = { balanceSnapshot: wallet.balance };

    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, observed);
      return undefined;
    }
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, observed);
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      reference = await this.transactions.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      // ausente, ou ela mesma ainda esperando a SUA referência (ex.: ROLLBACK de um REFUND pendente)
      if (reference === undefined || !reference.isTerminal()) {
        whenReferenceUnavailable();
        return undefined;
      }
      const referenceAlreadyReversed = tx.isReversal()
        ? await this.transactions.hasProcessedReversal(reference.id)
        : false;
      const failure = evaluateReference({
        transaction: tx,
        reference,
        referenceAlreadyReversed,
      });
      if (failure !== undefined) {
        tx.reject(failure, observed);
        return undefined;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed({
        at: now,
        balanceSnapshot: wallet.balance,
        referenceTransactionId: reference?.id,
      });
      return undefined; // LOSS: registra o resultado sem mover saldo
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      tx.reject(tx.insufficientFundsFailureCode(), observed);
      return undefined;
    }

    const movement = {
      money: tx.money,
      transactionId: tx.id,
      entryId: this.ids.next(),
      at: now,
    };
    const entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(movement)
        : wallet.credit(movement);
    tx.markProcessed({
      at: now,
      balanceSnapshot: wallet.balance,
      referenceTransactionId: reference?.id,
    });
    return entry;
  }

  /** Eventos de integração do desfecho, prontos para a outbox. */
  eventsFor(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    correlation: EventCorrelation,
    now: Date,
  ): OutboxMessage[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
      occurredAt: now,
    });

    const events: IntegrationEvent<unknown>[] = [];
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(tx, context()));
        if (entry !== undefined)
          events.push(WalletBalanceChanged.from(wallet, entry, context()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(tx, context()));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(tx, context()));
        break;
      default:
        break;
    }
    return events.map((event) => OutboxMessage.enqueue(event));
  }
}
