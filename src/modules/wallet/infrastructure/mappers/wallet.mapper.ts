import { LedgerEntryRecord } from '@/src/infrastructure/persistence/schemas/ledger-entry.schema';
import { WalletRecord } from '@/src/infrastructure/persistence/schemas/wallet.schema';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';
import { Money } from '@/src/shared/domain/money';

const money = (amount: string, currency: string): Money =>
  Money.from({ amount, currency });

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      walletVersion: record.walletVersion,
      direction: record.direction as LedgerDirection,
      money: money(record.amount, record.currency),
      balanceBefore: money(record.balanceBefore, record.currency),
      balanceAfter: money(record.balanceAfter, record.currency),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      walletVersion: entry.walletVersion,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    };
  },
};
