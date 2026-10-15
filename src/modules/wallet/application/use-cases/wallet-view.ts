import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import type { MoneyProps } from '@/src/shared/domain/money';
import type { Wallet } from '@/src/modules/wallet/domain/entities/wallet';
import type { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

/** Representação de saída da wallet: só JSON puro, dinheiro como MoneyProps. */
export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
