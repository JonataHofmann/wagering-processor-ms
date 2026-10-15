# Wallet creation

`POST /wallets` — `src/modules/wallet/presentation/controllers/wallets.controller.ts` →
`src/modules/wallet/application/use-cases/create-wallet.use-case.ts`

When the initial balance is greater than zero, opening the wallet generates an internal `OPENING`
transaction (the only way `OPENING` can exist — it is never submitted via the API nor the queue)
with a corresponding `CREDIT` entry, and the two integration events — all within the **same
SQL transaction** that inserts the wallet.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant Ctrl as WalletsController
    participant UC as CreateWalletUseCase
    participant W as Wallet (domain)
    participant TM as TransactionManager
    participant DB as PostgreSQL

    C->>Ctrl: POST /wallets { playerId, initialBalance }
    Ctrl->>UC: execute(command)
    UC->>UC: Money.from(initialBalance)<br/>(INVALID_AMOUNT/INVALID_CURRENCY if invalid)
    UC->>W: Wallet.open({ id, playerId, initialBalance })
    W-->>UC: { wallet (version=1), openingEntry? }

    UC->>TM: runInTransaction(...)
    activate TM
    TM->>DB: INSERT wallets (...)
    Note over DB: UNIQUE(player_id, currency)<br/>violated → 409 WALLET_ALREADY_EXISTS

    alt initialBalance == 0 (openingEntry undefined)
        Note over UC: nothing else to write:<br/>no transaction, no ledger, no event
    else initialBalance > 0
        UC->>UC: WagerTransaction.createOpening(...)<br/>markProcessed(...)
        UC->>DB: INSERT wager_transactions (kind=OPENING, status=PROCESSED)
        UC->>DB: INSERT wallet_ledger_entries (direction=CREDIT)
        UC->>DB: INSERT outbox (WagerTransactionProcessed, WalletBalanceChanged)
    end
    deactivate TM

    UC-->>Ctrl: WalletView
    Ctrl-->>C: 201 { id, playerId, balance, version: 1, ... }
```

## Important points

- **The `providerId` of the OPENING transaction is `"system"`**, reserved — no real provider can
  use it (`RESERVED_PROVIDER` if attempted).
- **Zero balance leaves no trace at all**: no `wager_transactions`, no `wallet_ledger_entries`,
  no event — only the row in `wallets`, with `version = 1`.
- The actual publication to the queue (`wallet-events.fifo`) **does not happen here**: the events
  only become rows in the `outbox` table; the one who publishes them is the relay (see
  [transactional-outbox.md](./transactional-outbox.md)).
- A duplicate wallet conflict (same `playerId` + `currency`) is caught by the database's
  `uq_wallets_player_currency` constraint, not only by an in-memory check — which is why it is
  safe even with two instances creating the same wallet at the same time.
