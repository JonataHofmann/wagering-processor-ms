import type { OutboxRepository } from '@/src/modules/messaging/application/ports/outbox.repository';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import type { LedgerRepository } from '@/src/modules/wallet/application/ports/ledger.repository';
import type { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import type { Clock } from '@/src/shared/application/ports/clock.port';
import type { TransactionManager } from '@/src/shared/application/ports/transaction-manager.port';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import type { WagerTransactionRepository } from './ports/wager-transaction.repository';
import type { ReferenceLookupPolicy } from './reference-lookup.policy';
import type { WagerSettlement } from './wager-settlement';

/** O que aconteceu com a pendência nesta tentativa. */
export type ResolutionOutcome =
  | 'resolved' // referência encontrada: PROCESSED ou REJECTED pela política
  | 'rescheduled' // referência ainda ausente: nova tentativa com backoff
  | 'expired' // prazo esgotado: REJECTED com REFERENCE_NOT_FOUND
  | 'skipped'; // já não estava pendente (outro scheduler, ou um atalho, resolveu antes)

export interface ResolvePendingReferenceDependencies {
  transactionManager: TransactionManager;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  clock: Clock;
  settlement: WagerSettlement;
  referenceLookup: ReferenceLookupPolicy;
}

/**
 * Reprocessa uma transação PENDING_REFERENCE, com as mesmas regras da primeira tentativa:
 * lock da wallet, releitura sob o lock, decisão compartilhada (WagerSettlement), e tudo
 * (transação, saldo, lançamento, eventos) gravado na mesma transação SQL.
 */
export class ResolvePendingReferenceUseCase {
  constructor(private readonly deps: ResolvePendingReferenceDependencies) {}

  async execute(transactionId: string): Promise<ResolutionOutcome> {
    const {
      transactionManager: tm,
      transactions,
      wallets,
      ledger,
      outbox,
      clock,
      settlement,
      referenceLookup,
    } = this.deps;

    // 1. descobre a wallet, numa transação curta e separada: a releitura do passo 2
    //    precisa vir do banco, não do identity map desta primeira leitura
    const candidate = await tm.runInTransaction(() =>
      transactions.findById(transactionId),
    );
    if (
      candidate === undefined ||
      candidate.status !== WagerTransactionStatus.PendingReference
    )
      return 'skipped';

    return tm.runInTransaction(async () => {
      // 2. lock da wallet e releitura: o estado que vale é o de depois do lock
      const wallet = await wallets.findByIdForUpdate(candidate.walletId);
      const tx = await transactions.findById(transactionId);
      if (
        wallet === undefined ||
        tx === undefined ||
        tx.status !== WagerTransactionStatus.PendingReference
      ) {
        return 'skipped';
      }

      const now = clock.now();
      const expectedVersion = wallet.version;
      let outcome = 'resolved' as ResolutionOutcome;

      // 3. a mesma decisão da primeira tentativa; muda só o que fazer se a referência continuar indisponível
      const entry = await settlement.decide(tx, wallet, now, () => {
        if (tx.isReferenceLookupExpired(now)) {
          tx.reject(FailureCode.ReferenceNotFound, {
            balanceSnapshot: wallet.balance,
          });
          outcome = 'expired';
        } else {
          tx.rescheduleReferenceLookup(
            referenceLookup.nextAttemptAt(now, tx.attempts + 1),
          );
          outcome = 'rescheduled';
        }
      });

      // 4. grava tudo na mesma transação
      if (entry !== undefined) await wallets.update(wallet, expectedVersion);
      await transactions.update(tx);
      if (entry !== undefined) await ledger.append(entry);
      if (outcome !== 'rescheduled') {
        // um reagendamento não é um fato de negócio novo: não gera evento
        await outbox.enqueue(
          settlement.eventsFor(
            tx,
            wallet,
            entry,
            { correlationId: tx.id },
            now,
          ),
        );
        // e quem esperava por ESTA transação (ex.: ROLLBACK de um REFUND) pode tentar agora
        await transactions.expediteWaitingFor(
          tx.providerId,
          tx.externalTransactionId,
          now,
        );
      }
      return outcome;
    });
  }
}
