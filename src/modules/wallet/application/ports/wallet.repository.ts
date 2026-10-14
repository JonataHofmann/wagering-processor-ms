import { Wallet } from '@/src/modules/wallet/domain/entities/wallet';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WalletRepository');
