import {
  LedgerPageQuery,
  LedgerRepository,
} from '@/src/modules/wallet/application/ports/ledger.repository';

import { EntityManagerContext } from '@/src/infrastructure/persistence/entity-manager-context';
import { LedgerEntryMapper } from '@/src/modules/wallet/infrastructure/mappers/wallet.mapper';
import { LedgerEntrySchema } from '@/src/infrastructure/persistence/schemas/ledger-entry.schema';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly context: EntityManagerContext) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.context
      .current()
      .insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async listByWallet(query: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const records = await this.context.current().find(
      LedgerEntrySchema,
      {
        walletId: query.walletId,
        ...(query.afterVersion !== undefined
          ? { walletVersion: { $gt: query.afterVersion } }
          : {}),
      },
      { orderBy: { walletVersion: 'asc' }, limit: query.limit },
    );
    return records.map(LedgerEntryMapper.toDomain);
  }
}
