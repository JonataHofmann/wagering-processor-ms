import type { InboxRepository } from '@/src/modules/messaging/application/ports/inbox.repository';
import type { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { InboxMessage } from '@/src/modules/messaging/domain/entities/inbox-message';
import { DuplicateWagerTransactionError } from '@/src/modules/wagering/error/wager-transaction.errors';
import {
  DuplicateMessageError,
  IdempotencyKeyReusedError,
} from '@/src/modules/wagering/error/wagering.errors';
import type { LedgerRepository } from '@/src/modules/wallet/application/ports/ledger.repository';
import type { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { IdGenerator } from '@/src/shared/application/ports/id-generator.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { ResourceNotFoundError } from '@/src/shared/error/application-errors';

import { computePayloadHash } from '@/src/modules/wagering/application/use-cases/payload-hash';

import type { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';

import { ReferenceLookupPolicy } from '@/src/modules/wagering/application/use-cases/reference-lookup.policy';
import { WagerTransaction } from '@/src/modules/wagering/domain/entities/wager-transaction';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { Money, MoneyProps } from '@/src/shared/domain/money';
import {
  toTransactionResult,
  type TransactionResult,
} from '@/src/modules/wagering/application/use-cases/transaction-view';
import type { WagerSettlement } from '@/src/modules/wagering/application/use-cases/wager-settlement';

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

/**
 * Mensagem de origem (SQS). Quando presente, o registro na inbox entra na MESMA
 * transação do efeito financeiro: ou os dois são confirmados, ou nenhum.
 */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerTransactionDependencies {
  transactionManager: TransactionManager;
  inbox: InboxRepository;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
  clock: Clock;
  settlement: WagerSettlement;
  referenceLookup: ReferenceLookupPolicy;
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
    receipt?: InboxReceipt,
  ): Promise<TransactionResult> {
    const { transactionManager: tm, transactions } = this.deps;

    const money = Money.from(command.money); // INVALID_AMOUNT / INVALID_CURRENCY → 400
    const payloadHash = computePayloadHash({ ...command, money });

    // 2. fast path: replays não pegam lock nenhum.
    //    Com inbox, o fast path é pulado: o replay também precisa registrar a mensagem,
    //    e isso acontece dentro da transação principal (passo 3).
    if (receipt === undefined) {
      const existing = await tm.runInTransaction(() =>
        transactions.findByIdempotencyKey(command.idempotencyKey),
      );
      if (existing !== undefined) return this.replay(existing, payloadHash);
    }

    try {
      return await tm.runInTransaction(async () => {
        await this.recordInbox(receipt); // DuplicateMessageError se for reentrega
        return this.processUnderLock(command, money, payloadHash);
      });
    } catch (error) {
      // 4. mesma key gravada por outra transação concorrente (ex.: outra wallet, logo outro lock)
      if (error instanceof DuplicateWagerTransactionError) {
        return tm.runInTransaction(async () => {
          await this.recordInbox(receipt);
          const winner = await transactions.findByIdempotencyKey(
            command.idempotencyKey,
          );
          if (winner === undefined) throw error;
          return this.replay(winner, payloadHash);
        });
      }
      throw error;
    }
  }

  /** Registra a mensagem na inbox, na transação atual. Reentrega → DuplicateMessageError. */
  private async recordInbox(receipt: InboxReceipt | undefined): Promise<void> {
    if (receipt === undefined) return;
    const message = InboxMessage.receive({
      ...receipt,
      receivedAt: this.deps.clock.now(),
    });
    if (!(await this.deps.inbox.tryRegister(message))) {
      throw new DuplicateMessageError(receipt.consumerName, receipt.messageId);
    }
    message.markProcessed(this.deps.clock.now());
    await this.deps.inbox.markProcessed(message);
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
    const entry = await this.deps.settlement.decide(
      transaction,
      wallet,
      now,
      () =>
        transaction.markPendingReference(
          this.deps.referenceLookup.firstSchedule(now),
        ),
    ); // fora de ordem: espera

    if (entry !== undefined) await wallets.update(wallet, expectedVersion);
    await transactions.insert(transaction); // DuplicateWagerTransactionError se outra venceu
    if (entry !== undefined) await ledger.append(entry);
    await outbox.enqueue(
      this.deps.settlement.eventsFor(transaction, wallet, entry, command, now),
    );

    // atalho: quem estava esperando por esta transação não precisa esperar o próximo ciclo do backoff
    if (transaction.isTerminal()) {
      await transactions.expediteWaitingFor(
        transaction.providerId,
        transaction.externalTransactionId,
        now,
      );
    }

    return toTransactionResult(transaction, false);
  }
}
