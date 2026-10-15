# Processing a wager transaction

The system's central flow. `POST /wagering/transactions` (HTTP) and consuming
`wager-transactions.fifo` (SQS) call **the same use case** —
`ProcessWagerTransactionUseCase.execute()`
(`src/modules/wagering/application/use-cases/process-wager-transaction.use-case.ts`) — there is no
duplicated business logic between the two channels.

## Full flow (happy path: new transaction, PROCESSED)

```mermaid
sequenceDiagram
    autonumber
    participant C as HTTP Client / SQS Consumer
    participant Ctrl as WageringController / WagerMessageHandler
    participant UC as ProcessWagerTransactionUseCase
    participant TM as TransactionManager
    participant Wrepo as WalletRepository
    participant Settle as WagerSettlement
    participant Txrepo as WagerTransactionRepository
    participant Ledger as LedgerRepository
    participant Outbox as OutboxRepository
    participant DB as PostgreSQL

    C->>Ctrl: operation + Idempotency-Key (HTTP) or messageId (SQS)
    Ctrl->>UC: execute(command, receipt?)
    UC->>UC: Money.from(command.money)
    UC->>UC: payloadHash = canonicalHash(business fields)

    opt HTTP only — receipt === undefined: fast path without lock
        UC->>Txrepo: findByIdempotencyKey(key)
        Note over Txrepo: if it already exists, replay the response here<br/>and stop (see idempotency, below)
    end

    UC->>TM: runInTransaction(...)
    activate TM
    opt SQS only — receipt present
        UC->>DB: INSERT inbox_messages (consumerName, messageId)
        Note over DB: UNIQUE(consumer_name, message_id) already exists<br/>→ DuplicateMessageError (see sqs-messaging.md)
    end

    UC->>Wrepo: findByIdForUpdate(walletId)
    Wrepo->>DB: SELECT ... FOR UPDATE
    Note over DB: lock_timeout own to the transaction,<br/>exhausted → 503 (see concurrency.md)
    DB-->>Wrepo: row locked until commit
    Wrepo-->>UC: wallet (404 WALLET_NOT_FOUND if it doesn't exist)

    UC->>Txrepo: findByIdempotencyKey(key) — recheck UNDER the lock
    Note over Txrepo: whoever waited on the lock may have lost<br/>the race for the same key

    UC->>UC: WagerTransaction.create(...) — born PENDING
    UC->>Settle: decide(tx, wallet, now, onReferenceUnavailable)
    Note over Settle: rules per kind, reference resolution —<br/>see settlement-rules.md
    Settle-->>UC: WalletLedgerEntry | undefined

    opt balance changed (entry !== undefined)
        UC->>Wrepo: update(wallet, expectedVersion)
        Note over DB: version doesn't match → lost update<br/>detected (see concurrency.md)
    end
    UC->>Txrepo: insert(tx)
    Note over DB: UNIQUE(idempotency_key) violated by another<br/>concurrent transaction → race (see below)
    opt balance changed
        UC->>Ledger: append(entry)
    end
    UC->>Outbox: enqueue(outcome events)
    deactivate TM

    UC-->>Ctrl: TransactionResult { status, balance, idempotentReplay: false }
    Ctrl-->>C: 200 PROCESSED / 202 PENDING(_REFERENCE) / 422 REJECTED / 500 FAILED
```

## Idempotency: replay vs. race vs. conflict

```mermaid
flowchart TD
    Start(["key + payload arrive"]) --> Fast{"fast path (HTTP only):<br/>does key already exist?"}
    Fast -- "yes, same hash" --> Replay["replay:<br/>idempotentReplay=true,<br/>returns the result and balance from back then"]
    Fast -- "yes, different hash" --> Conflict["409 IDEMPOTENCY_KEY_REUSED"]
    Fast -- "no (or it's SQS)" --> Lock["wallet lock + recheck"]
    Lock -- "appeared between the check<br/>and the lock" --> Replay
    Lock -- "still doesn't exist" --> Insert["processUnderLock: creates and inserts"]
    Insert -- "INSERT ok" --> Done(["new result"])
    Insert -- "UNIQUE(idempotency_key)<br/>violated" --> Race["another wallet won the race<br/>(different lock, same key)"]
    Race --> Reread["rereads the transaction by key,<br/>in a new short transaction"]
    Reread -- "same hash" --> Replay
    Reread -- "different hash" --> Conflict
```

This last branch (`Race`) is the only way two requests with the **same key** but
**different wallets** can collide: since the lock is per wallet, they don't compete for the same
lock — whoever commits first writes the key; the other one receives `DuplicateWagerTransactionError`
from the database (`UNIQUE(idempotency_key)`), rereads in a new transaction, and decides replay or
conflict. See `ARCHITECTURE.en.md` (ADR-011) for the exact `payloadHash` algorithm.

## Differences between the HTTP channel and the SQS channel

| | HTTP | SQS |
|---|---|---|
| Request identity | `Idempotency-Key` (header) | envelope's `messageId` |
| Fast path without lock | Yes | No — always enters the transaction (needs to write the inbox anyway) |
| Deduplication record | Only `UNIQUE(idempotency_key)` | Inbox (`consumerName`, `messageId`) **and** the idempotency key |
| Confirmation to the caller | Synchronous HTTP response | `ack` **only after commit** (see [sqs-messaging.md](./sqs-messaging.md)) |
| Redelivery | Client decides to resend | SQS redelivers on its own; the inbox guarantees the effect doesn't duplicate |

## Files

- `src/modules/wagering/application/use-cases/process-wager-transaction.use-case.ts` — orchestration.
- `src/modules/wagering/application/use-cases/payload-hash.ts` + `src/shared/util/canonical-hash.ts` — `payloadHash`.
- `src/modules/wagering/presentation/controllers/wagering.controller.ts` — HTTP entry point.
- `src/modules/wagering/infrastructure/sqs/wager-message.handler.ts` — SQS entry point.
