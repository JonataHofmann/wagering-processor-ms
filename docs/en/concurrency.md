# Concurrency: two bets disputing the same wallet

Mandatory scenario from the spec: initial balance `100.00 BRL`, two bets of `80.00 BRL`
processed **simultaneously** (by any combination of instances). Expected result:
exactly one `PROCESSED`, the other `REJECTED` with `INSUFFICIENT_FUNDS`, final balance `20.00`,
exactly **one** `DEBIT` entry.

The unit of concurrency is the `walletId`. The strategy is a pessimistic lock (`SELECT ... FOR UPDATE`)
plus an optimistic `version` check on `UPDATE` — belt and suspenders (ADR-010 in
`ARCHITECTURE.en.md`).

```mermaid
sequenceDiagram
    autonumber
    participant A as Instance 1 — bet A (80.00)
    participant DB as PostgreSQL (wallet row)
    participant B as Instance 2 — bet B (80.00)

    par arrive at the same time
        A->>DB: BEGIN, SELECT ... FOR UPDATE WHERE id = wallet
    and
        B->>DB: BEGIN, SELECT ... FOR UPDATE WHERE id = wallet
    end

    Note over DB: only one row, only one lock —<br/>Postgres serializes the two

    DB-->>A: lock granted (balance=100.00, version=1)
    Note over B: B is blocked waiting<br/>for the transaction's lock_timeout

    A->>A: WagerSettlement.decide():<br/>canDebit(80.00)? yes
    A->>DB: UPDATE wallets SET balance=20.00, version=2<br/>WHERE id=wallet AND version=1
    A->>DB: INSERT wager_transactions (status=PROCESSED)
    A->>DB: INSERT wallet_ledger_entries (DEBIT, 80.00)
    A->>DB: COMMIT
    Note over DB: lock released

    DB-->>B: lock granted (balance=20.00, version=2 — already updated)
    B->>B: WagerSettlement.decide():<br/>canDebit(80.00)? NO (only 20.00 available)
    B->>DB: INSERT wager_transactions (status=REJECTED,<br/>failureCode=INSUFFICIENT_FUNDS)
    Note over B: no UPDATE on wallets,<br/>no ledger entry
    B->>DB: COMMIT

    Note over DB: final balance 20.00 · version=2 ·<br/>exactly 1 DEBIT entry
```

## Why this remains correct with 3+ instances

The diagram above does not change at all if "Instance 1"/"Instance 2" are completely different
operating system processes, each with its own connection pool — the serialization point is the
**Postgres row**, not shared application memory. No instance keeps business state in memory
(ADR-012); any replica can serve any request.

```mermaid
flowchart LR
    Client -->|round-robin| I1["Instance 1<br/>(process 1)"]
    Client -->|round-robin| I2["Instance 2<br/>(process 2)"]
    Client -->|round-robin| I3["Instance 3<br/>(process 3)"]
    I1 --> PG[("PostgreSQL<br/>lock per walletId")]
    I2 --> PG
    I3 --> PG
```

## What happens if the lock takes too long

Each transaction has its own `lock_timeout`/`statement_timeout` (`MikroTransactionManager`).
If the lock is not granted in time (hot wallet under extreme load, or a bug holding the
transaction for too long), Postgres cancels it with SQLSTATE `55P03`
(`isTransientDatabaseError`/`isLockConflict` in `pg-error.ts`) and the application responds **503**
with `Retry-After`, with no effect at all — it never holds the whole instance waiting forever. This
also increments the `database_lock_conflicts_total` metric (see
[observability.md](./observability.md)).

## Where this is proven

| Test | Granularity |
|---|---|
| `test/concurrency/single-instance.test.ts` | Same process, real `Promise.all` |
| `test/concurrency/multi-instance.test.ts` | **3 real OS processes** (`bun src/main.ts`), same database |
| `test/integration/http/wagering.http.test.ts` | HTTP version of the scenario, end to end |
| `test/resilience/restart-consistency.test.ts` | The same principle, under real `SIGKILL`/`SIGTERM` |

Final invariant verified in all of them: `wallet.balance == balance reconstructed from the ledger`
(`test/support/invariants.ts`).
