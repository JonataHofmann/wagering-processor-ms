import { InsufficientFundsError } from '@/src/modules/wallet/error/wallet.errors';
import { Money } from '@/src/shared/domain/money';
import { CurrencyMismatchError } from '@/src/shared/error/currency-mismatch-error';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { WalletLedgerEntry } from '@/src/modules/wallet/domain/entities/wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** id da transação OPENING; só é usado se o saldo inicial for > 0 */
  openingTransactionId: string;
  /** id do lançamento OPENING; só é usado se o saldo inicial for > 0 */
  openingEntryId: string;
  openedAt: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  /** undefined quando o saldo inicial é zero: sem movimento, sem lançamento */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados de um movimento. Ids e data vêm da camada de aplicação. */
export interface MovementCommand {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // ------------------------------------------------------------ criação

  /**
   * Abre uma wallet na versão 1. Com saldo inicial > 0, devolve também o
   * lançamento OPENING (CREDIT, v1, 0 → saldo inicial).
   */
  static open(props: OpenWalletProps): WalletOpening {
    const { initialBalance, openedAt } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError(
        `initial balance must not be negative, got ${initialBalance}`,
      );
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      openedAt,
      openedAt,
    );

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: openedAt,
    });

    return { wallet, openingEntry };
  }

  /** Reconstrói a partir do banco. Não revalida: só restaura o estado persistido. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.subtract(money).isNegative();
  }

  /** Debita e devolve o lançamento. Lança InsufficientFundsError se o saldo ficaria negativo. */
  debit(command: MovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(command.money);
    this.assertPositive(command.money);

    const after = this._balance.subtract(command.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(this._balance, command.money);
    }
    return this.apply(LedgerDirection.Debit, command, after);
  }

  /** Credita e devolve o lançamento. */
  credit(command: MovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(command.money);
    this.assertPositive(command.money);
    return this.apply(
      LedgerDirection.Credit,
      command,
      this._balance.add(command.money),
    );
  }

  /**
   * Único ponto que altera o saldo. Cria o lançamento ANTES de mudar o estado:
   * se a criação falhar, a wallet continua exatamente como estava.
   */
  private apply(
    direction: LedgerDirection,
    command: MovementCommand,
    after: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: command.entryId,
      walletId: this.id,
      transactionId: command.transactionId,
      walletVersion: this._version + 1,
      direction,
      money: command.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: command.at,
    });

    this._version += 1;
    this._balance = after;
    this._updatedAt = command.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvariantViolationError(
        `movement amount must be positive, got ${money}`,
      );
    }
  }
}
