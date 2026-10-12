import { LedgerDirection } from '@/src/modules/wallet/domain/ledger-direction';
import { Money } from '@/src/shared/domain/money';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this); // imutabilidade estrutural, também em tempo de execução
  }

  /** Cria um lançamento NOVO, validando todas as suas invariantes. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    if (
      balanceBefore.currency !== money.currency ||
      balanceAfter.currency !== money.currency
    ) {
      throw new InvariantViolationError(
        `ledger entry currencies differ: money ${money.currency}, ` +
          `before ${balanceBefore.currency}, after ${balanceAfter.currency}`,
      );
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError(
        `ledger entry amount must be positive, got ${money}`,
      );
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvariantViolationError(
        `ledger entry balances must not be negative: ${balanceBefore} → ${balanceAfter}`,
      );
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError(
        `ledger entry walletVersion must be an integer >= 1, got ${props.walletVersion}`,
      );
    }

    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `unbalanced ledger entry: ${balanceBefore} ${props.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrói a partir do banco. NÃO revalida: o estado já foi aceito quando foi gravado. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.walletVersion,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Valor com sinal: positivo no crédito, negativo no débito. Base da reconciliação. */
  signedMoney(): Money {
    return this.direction === LedgerDirection.Credit
      ? this.money
      : this.money.negate();
  }
}
