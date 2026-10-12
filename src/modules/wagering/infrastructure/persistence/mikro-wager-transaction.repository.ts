import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { isUniqueViolation } from '@/src/infrastructure/persistence/pg-error';
import { WagerTransactionSchema } from '@/src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WagerTransactionRepository } from '@/src/modules/wagering/application/ports/wager-transaction.repository';
import { WagerTransaction } from '@/src/modules/wagering/domain/wager-transaction';
import { DuplicateWagerTransactionError } from '@/src/modules/wagering/error/wager-transaction.errors';
import { WagerTransactionMapper } from '@/src/modules/wagering/infrastructure/persistence/wager-transaction.mapper';
import { Clock } from '@/src/shared/application/ports/clock.port';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    private readonly context: EntityManagerContext,
    private readonly clock: Clock,
  ) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.context
      .current()
      .findOne(WagerTransactionSchema, { id });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.context
      .current()
      .findOne(WagerTransactionSchema, { idempotencyKey });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.context
      .current()
      .findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    // mesma condição do índice único parcial uq_wtx_single_reversal
    const count = await this.context.current().count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.context
        .current()
        .insert(
          WagerTransactionSchema,
          WagerTransactionMapper.toRecord(transaction, this.clock.now()),
        );
    } catch (error) {
      if (
        isUniqueViolation(error, 'uq_wtx_idempotency_key') ||
        isUniqueViolation(error, 'uq_wtx_provider_external')
      ) {
        throw new DuplicateWagerTransactionError(transaction.idempotencyKey);
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const affected = await this.context.current().nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      {
        ...WagerTransactionMapper.toLifecycleColumns(transaction),
        updatedAt: this.clock.now(),
      },
    );
    if (affected !== 1) {
      throw new InvariantViolationError(
        `wager transaction ${transaction.id} not found for update`,
      );
    }
  }
}
