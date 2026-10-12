import type { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { OutboxMessage } from '@/src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '@/src/modules/wagering/domain/events/wallet-balance-changed.event'; //REVISAR
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import type { LedgerRepository } from '@/src/modules/wallet/application/ports/ledger.repository';
import type { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import { LedgerDirection } from '@/src/modules/wallet/domain/ledger-direction';
import type { Wallet } from '@/src/modules/wallet/domain/wallet';
import { ResourceNotFoundError } from '@/src/shared/application/application-errors';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { IdGenerator } from '@/src/shared/application/ports/id-generator.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import type {
  EventContext,
  IntegrationEvent,
} from '@/src/shared/domain/integration-event';
import { Money, type MoneyProps } from '@/src/shared/domain/money';

import { computePayloadHash } from '@/src/modules/wagering/application/payload-hash';
import { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { REFERENCE_LOOKUP } from '@/src/modules/wagering/application/reference-lookup.policy';
import {
  TransactionResult,
  toTransactionResult,
} from '@/src/modules/wagering/application/transaction-view';
import { WagerTransactionPendingReference } from '@/src/modules/wagering/domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '@/src/modules/wagering/domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '@/src/modules/wagering/domain/events/wager-transaction-rejected.event';
import { evaluateReference } from '@/src/modules/wagering/domain/reference-policy';
import { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/wager-transaction-status';
import { DuplicateWagerTransactionError } from '@/src/modules/wagering/error/wager-transaction.errors';
import { IdempotencyKeyReusedError } from '@/src/modules/wagering/error/wagering.errors';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/wallet-ledger-entry';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** o que causou esta operação (ex.: messageId do SQS) */
  causationId?: string;
}

export interface ProcessWagerTransactionDependencies {
  transactionManager: TransactionManager;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
}

/**
 * O caso de uso central. Usado igualmente pela API HTTP e pelo consumer SQS.
 *
 *  1. valida o payload e calcula o payloadHash (fora de transação)
 *  2. fast path: a key já existe? replay ou conflito, sem lock
 *  3. transação: lock da wallet → re-checa a key sob o lock → decide → grava tudo + outbox
 *  4. se outra transação venceu a corrida da mesma key (unique), relê e faz replay ou conflito
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerTransactionDependencies) {}

  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<TransactionResult> {
    const { transactionManager: tm, transactions } = this.deps;

    const money = Money.from(command.money); // INVALID_AMOUNT / INVALID_CURRENCY → 400
    const payloadHash = computePayloadHash({ ...command, money });

    // 2. fast path: replays não pegam lock nenhum
    const existing = await tm.runInTransaction(() =>
      transactions.findByIdempotencyKey(command.idempotencyKey),
    );
    if (existing !== undefined) return this.replay(existing, payloadHash);

    try {
      return await tm.runInTransaction(() =>
        this.processUnderLock(command, money, payloadHash),
      );
    } catch (error) {
      // 4. mesma key gravada por outra transação concorrente (ex.: outra wallet, logo outro lock)
      if (error instanceof DuplicateWagerTransactionError) {
        const winner = await tm.runInTransaction(() =>
          transactions.findByIdempotencyKey(command.idempotencyKey),
        );
        if (winner !== undefined) return this.replay(winner, payloadHash);
      }
      throw error;
    }
  }

  private replay(
    existing: WagerTransaction,
    payloadHash: string,
  ): TransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyKeyReusedError(existing.idempotencyKey);
    }
    return toTransactionResult(existing, true);
  }

  private async processUnderLock(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<TransactionResult> {
    const { wallets, transactions, ledger, outbox, ids, clock } = this.deps;
    const now = clock.now();

    // SELECT ... FOR UPDATE: daqui até o COMMIT, ninguém mais mexe nesta wallet
    const wallet = await wallets.findByIdForUpdate(command.walletId);
    if (wallet === undefined) {
      throw new ResourceNotFoundError(
        'WALLET_NOT_FOUND',
        `wallet ${command.walletId} not found`,
      );
    }

    // re-checagem autoritativa: quem esperou o lock pode ter perdido para a mesma key
    const alreadyProcessed = await transactions.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (alreadyProcessed !== undefined)
      return this.replay(alreadyProcessed, payloadHash);

    const transaction = WagerTransaction.create({
      id: ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const expectedVersion = wallet.version;
    const entry = await this.decide(transaction, wallet, now);

    if (entry !== undefined) await wallets.update(wallet, expectedVersion);
    await transactions.insert(transaction); // DuplicateWagerTransactionError se outra venceu
    if (entry !== undefined) await ledger.append(entry);
    await outbox.enqueue(
      this.eventsFor(transaction, wallet, entry, command, now),
    );

    return toTransactionResult(transaction, false);
  }

  /**
   * Aplica as regras e muda o estado da transação (e da wallet, se houver movimento).
   * Devolve o lançamento quando o saldo mudou.
   */
  private async decide(
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
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
      reference = await this.deps.transactions.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (reference === undefined) {
        tx.markPendingReference(REFERENCE_LOOKUP.firstSchedule(now)); // fora de ordem: espera (etapa 16)
        return undefined;
      }
      const referenceAlreadyReversed = tx.isReversal()
        ? await this.deps.transactions.hasProcessedReversal(reference.id)
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
      entryId: this.deps.ids.next(),
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

  private eventsFor(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    command: ProcessWagerTransactionCommand,
    now: Date,
  ): OutboxMessage[] {
    const context = (): EventContext => ({
      eventId: this.deps.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
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
