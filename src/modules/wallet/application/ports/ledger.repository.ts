import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

export interface LedgerPageQuery {
  walletId: string;
  /** devolve lançamentos com walletVersion maior que este (cursor) */
  afterVersion?: number;
  limit: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Em ordem crescente de walletVersion. */
  listByWallet(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
}

export const LEDGER_REPOSITORY = Symbol('LedgerRepository');
