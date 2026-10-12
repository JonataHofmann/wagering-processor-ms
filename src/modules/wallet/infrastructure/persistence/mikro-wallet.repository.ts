import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { isUniqueViolation } from '@/src/infrastructure/persistence/pg-error';
import { WalletSchema } from '@/src/infrastructure/persistence/schemas/wallet.schema';
import { WalletRepository } from '@/src/modules/wallet/application/ports/wallet.repository';
import { Wallet } from '@/src/modules/wallet/domain/wallet';
import { WalletAlreadyExistsError } from '@/src/modules/wallet/error/wallet.errors';
import { WalletMapper } from '@/src/modules/wallet/infrastructure/persistence/wallet.mapper';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { LockMode } from '@mikro-orm/postgresql';

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.context.current().findOne(WalletSchema, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.context
      .current()
      .findOne(
        WalletSchema,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.context
        .current()
        .insert(WalletSchema, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.context.current().nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new InvariantViolationError(
        `wallet ${wallet.id} was not at version ${expectedVersion} (concurrent change without lock?)`,
      );
    }
  }
}
