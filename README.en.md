# Distributed Wagering Processor

Service that processes financial wagering transactions (BET, WIN, LOSS, REFUND, ROLLBACK) coming from game providers, via **HTTP** and via **SQS queue**, keeping each player's wallet consistent under concurrency, message redelivery, partial failures and multiple instances.

The design principle is simple: **no financial guarantee depends on a single layer.** The domain decides, the lock serializes, idempotency is persistent, and PostgreSQL itself refuses (via constraints, triggers and permissions) any state in which the balance diverges from the ledger.

Architecture decisions, alternatives and trade-offs are in [ARCHITECTURE.en.md](ARCHITECTURE.en.md).

---

## Summary

1. [Current state](#current-state)
2. [What the system guarantees](#what-the-system-guarantees)
3. [Stack](#stack)
4. [Architecture in one minute](#architecture-in-one-minute)
5. [Prerequisites](#prerequisites)
6. [Quick start](#quick-start)
7. [Running with multiple instances](#running-with-multiple-instances)
8. [Configuration](#configuration)
9. [HTTP API](#http-api)
10. [Input via SQS queue](#input-via-sqs-queue)
11. [Published events](#published-events)
12. [Observability](#observability)
13. [Business rules](#business-rules)
14. [Tests](#tests)
15. [Operation](#operation)
16. [Project structure](#project-structure)
17. [Troubleshooting](#troubleshooting)
18. [Known limitations](#known-limitations)

---

## Current state

| Area                                                                     | Status                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Schema with constraints, integrity triggers and minimal permissions     | ✓                                                                     |
| Domain: exact `Money`, `Wallet`, `WagerTransaction`, immutable ledger    | ✓                                                                     |
| HTTP API with persistent idempotency (`Idempotency-Key`)                | ✓                                                                     |
| Pessimistic lock per wallet; concurrency tests on 1 and on 3 processes | ✓                                                                     |
| SQS consumer with transactional inbox, retry with backoff and DLQ             | ✓                                                                     |
| Transactional outbox with concurrent relay (lease + `SKIP LOCKED`)       | ✓                                                                     |
| Out-of-order references (`PENDING_REFERENCE`, backoff, TTL, scheduler) | ✓                                                                     |
| Balance × ledger reconciliation (endpoint and command)                        | ✓                                                                     |
| Resilience tests with real processes (SIGKILL, SIGTERM)             | ✓                                                                     |
| Restart-under-load test with proof of eventual consistency              | ✓                                                                     |
| Observability: JSON logs, `/metrics` (Prometheus), `/health/ready`     | ✓                                                                     |
| Provider authentication                                               | Structure ready via `ProviderIdentityPort`/`AuthModule` (ADR-008); adapter is a no-op, real Keycloak integration pending |

---

## What the system guarantees

| Guarantee                                                  | How                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Money is never `number`                                 | `Money` encapsulates `decimal.js`; in the database, the `money_amount` domain **rejects** (does not round) a third decimal place               |
| Balance never negative, not even under a race                     | `SELECT ... FOR UPDATE` lock per wallet + `CHECK` in the database                                                                             |
| No duplicate debit or credit                        | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, re-check under the lock, inbox keyed by `(consumer, messageId)` |
| Repeating a request returns the original result       | Every decision (including rejection) is recorded with the observed balance; replay reads the recorded transaction                                              |
| Same `Idempotency-Key` with different content is a conflict | `payloadHash` (SHA-256 of canonical RFC 8785 JSON) → `409 IDEMPOTENCY_KEY_REUSED`                                                       |
| Balance, ledger, transaction, inbox and outbox are atomic     | A single SQL transaction per operation; deferred triggers check coherence on `COMMIT`                                                |
| Auditable and immutable ledger                               | Append-only via trigger **and** via permission (the application has no `UPDATE`/`DELETE`)                                                  |
| No event published before the commit                   | The use case only writes to the outbox; the relay publishes afterward, reading what has already been confirmed                                                |
| Works with N instances                                 | No business state in memory; everything lives in PostgreSQL                                                              |
| One reversal per reference                                   | Partial unique index: REFUND and ROLLBACK combined, at most one per referenced transaction                               |

---

## Stack

| Component     | Version                                                     |
| -------------- | ---------------------------------------------------------- |
| Runtime        | Bun 1.4                                                    |
| HTTP framework | NestJS 12                                                  |
| ORM            | MikroORM 7 (explicit writes, no implicit Unit of Work) |
| Database          | PostgreSQL 16                                              |
| Queue           | Amazon SQS (FIFO); locally, LocalStack 3.8                 |
| Money       | `decimal.js`, encapsulated in `Money`                       |
| Tests         | `bun test`, against real PostgreSQL and SQS                  |

---

## Architecture in one minute

```
                      ┌──────────────────────── instance (N replicas) ─────────────────────────┐
 provider ──HTTP────▶ │  api        → ProcessWagerTransactionUseCase ─┐                         │
                      │                                               │  1 SQL transaction:       │
 wager-transactions ─▶│  consumer   → inbox + same use case ──────┼─▶ wallet lock,       │──▶ PostgreSQL
   .fifo (SQS)        │                                               │   transaction, balance,     │    (wallets, ledger,
                      │  scheduler  → resolves PENDING_REFERENCE ──────┘   ledger, outbox        │     transactions, inbox,
                      │                                                                         │     outbox)
                      │  relay      → reads the outbox (lease + SKIP LOCKED) ───────────────────────────▶ wallet-events.fifo
                      └─────────────────────────────────────────────────────────────────────────┘     (SQS)
```

- **Modular hexagonal monolith**: `wallet`, `wagering` and `messaging` modules, each with `domain`, `application` (use cases and ports) and `infrastructure` (adapters). The domain knows nothing about Nest or the ORM.
- **A single central use case** serves both HTTP and SQS.
- **Every instance does everything**: the same image always serves HTTP, consumes `wager-transactions.fifo`, publishes the outbox and resolves `PENDING_REFERENCE` — no extra configuration, no role to pick.

---

## Prerequisites

| Tool              | Version                                |
| ----------------------- | ------------------------------------- |
| Bun                     | 1.4 or higher (`bun --version`)     |
| Docker and Docker Compose | Compose v2 (`docker compose version`) |
| Git                     | any recent version                       |

Ports used locally: `5432` (PostgreSQL), `4566` (LocalStack), `3000` (application).

---

## Quick start

```bash
# 1. dependencies
bun install

# 2. local configuration
cp .env.example .env

# 3. PostgreSQL + LocalStack (with the 3 FIFO queues and the redrive policy)
bun run infra:up

# 4. schema
bun run migrate:up

# 5. application (API + consumer + relay + scheduler, with reload)
bun run dev
```

Check:

```bash
curl -s localhost:3000/health/live
# {"status":"ok"}
```

### First wager

```bash
# create the wallet
PLAYER=$(uuidgen | tr 'A-Z' 'a-z')
WALLET=$(curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

# place a bet
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",
       \"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",
       \"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

```json
{
  "transactionId": "0192f298-...",
  "status": "PROCESSED",
  "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Repeat the same command: the response is identical, with `"idempotentReplay": true`, and the balance does not change. Change the `amount` while keeping the key: `409 IDEMPOTENCY_KEY_REUSED`.

---

## Running with multiple instances

There is no Docker Compose or load balancer for the application in this repository — `docker-compose.yaml` only brings up PostgreSQL and LocalStack (section [Quick start](#início-rápido)). "Multiple instances" here means several `bun src/main.ts` processes pointing to the **same** `DATABASE_URL`, each on a different port:

```bash
PORT=3001 bun src/main.ts &
PORT=3002 bun src/main.ts &
PORT=3003 bun src/main.ts &
```

No instance keeps business state in memory, so there is no session affinity: any one of them serves any request, including the replay of an operation processed by another. Without a load balancer, the client is the one who chooses the instance and decides to resend to another on failure, protected by the `Idempotency-Key` — this is exactly the pattern exercised by `test/concurrency/multi-instance.test.ts` and `test/resilience/restart-consistency.test.ts`, via `test/support/app-process.ts`.

---

## Configuration

Bun loads `.env` automatically. `.env.example` provides all the default development values.

### Application and database

| Variable                 | Default                         | Description                                                                       |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------- |
| `PORT`                   | `3000`                         | HTTP port                                                                      |
| `DATABASE_URL`           | —                              | Runtime connection, with the `wagering_app` role (no `UPDATE`/`DELETE` on the ledger) |
| `DATABASE_MIGRATION_URL` | —                              | Migrations connection, with the `wagering_owner` role                             |
| `MIKRO_ORM_DEBUG`        | `false`                        | `true` prints every query                                                      |
| `LOG_LEVEL`              | `info`                         | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`                    |
| `LOG_FORMAT`             | `json`                         | `json` (structured) or `text`                                                  |

### SQS

| Variable                                     | Default                        | Description                                              |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `AWS_REGION`                                 | `us-east-1`                   | Region                                                 |
| `AWS_ENDPOINT_URL`                           | —                             | `http://localhost:4566` with LocalStack; absent on AWS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test`                        | Credentials (LocalStack accepts any value)         |
| `SQS_WAGER_QUEUE`                            | `wager-transactions.fifo`     | Transaction input                                  |
| `SQS_WAGER_DLQ`                              | `wager-transactions-dlq.fifo` | Dead-letter queue for the input                            |
| `SQS_EVENTS_QUEUE`                           | `wallet-events.fifo`          | Event output                                  |
| `SQS_WAIT_TIME_SECONDS`                      | `20`                          | Consumer long polling                                |
| `SQS_MAX_RECEIVE_COUNT`                      | `5`                           | Attempts before the DLQ (matches the redrive policy)       |
| `SQS_SHUTDOWN_TIMEOUT_MS`                    | `20000`                       | Time to finish in-flight messages on SIGTERM  |

### Outbox relay

| Variable                  | Default  | Description                                                        |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `OUTBOX_BATCH_SIZE`       | `10`    | Events per round                                               |
| `OUTBOX_LEASE_MS`         | `30000` | Lease on a batch; if the relay dies, another takes over after this | 
| `OUTBOX_IDLE_INTERVAL_MS` | `500`   | Wait between rounds when there is nothing pending                     |

### Out-of-order references

| Variable                            | Default   | Description                                                  |
| ----------------------------------- | -------- | ---------------------------------------------------------- |
| `PENDING_REFERENCE_BACKOFF_BASE_MS` | `1000`   | First wait; doubles each attempt                    |
| `PENDING_REFERENCE_BACKOFF_MAX_MS`  | `60000`  | Cap between attempts                                      |
| `PENDING_REFERENCE_TTL_MS`          | `900000` | Deadline (15 min) before rejecting with `REFERENCE_NOT_FOUND` |
| `SCHEDULER_BATCH_SIZE`              | `20`     | Pending items per round                                      |
| `SCHEDULER_LEASE_MS`                | `10000`  | Lease on each pending item                                      |
| `SCHEDULER_IDLE_INTERVAL_MS`        | `500`    | Wait between rounds                                       |

### Tests

| Variable                  | Description                                                            |
| ------------------------- | -------------------------------------------------------------------- |
| `TEST_DATABASE_ADMIN_URL` | Owner on the `postgres` database: creates and drops test databases           |
| `TEST_DATABASE_APP_URL`   | `wagering_app` on the `postgres` database: base for test connections     |
| `CONCURRENCY_ITERATIONS`  | Repetitions of each race in concurrency tests (default 10)    |
| `APP_LOGS`                | `true` shows Nest logs in integration tests               |
| `APP_PROCESS_LOGS`        | `true` shows child process logs in multi-process tests |

---

## HTTP API

### Endpoints

| Method and route                                                             | Description                                                       | Success         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------- |
| `POST /wallets`                                                           | Creates a player's wallet in a currency                          | 201             |
| `GET /wallets/:walletId`                                                  | Current balance and version                                          | 200             |
| `GET /wallets/:walletId/ledger?limit=&cursor=`                            | Entries, in version order, paginated by cursor           | 200             |
| `POST /wallets/:walletId/reconciliation`                                  | Compares the stored balance with the ledger balance (read-only) | 200             |
| `POST /wagering/transactions`                                             | Processes a transaction (`Idempotency-Key` header required)   | 200 / 202 / 422 |
| `GET /wagering/transactions/:transactionId`                               | Lookup by internal id                                        | 200             |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Lookup by provider id                                    | 200             |
| `GET /health/live`                                                        | Liveness (does not query dependencies)                            | 200             |
| `GET /health/ready`                                                       | Readiness: PostgreSQL and SQS reachable                         | 200 / 503       |
| `GET /metrics`                                                            | Metrics in Prometheus format (see [Observability](#observability)) | 200             |

Optional headers: `X-Correlation-Id` is propagated to the events generated by the request.

### Create wallet

```http
POST /wallets
Content-Type: application/json

{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

```json
{
  "id": "0192f290-...",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1,
  "createdAt": "2026-10-13T12:00:00.000Z",
  "updatedAt": "2026-10-13T12:00:00.000Z"
}
```

An initial balance greater than zero generates an internal `OPENING` transaction and the first ledger entry. A second wallet for the same player and currency responds `409 WALLET_ALREADY_EXISTS`.

### Process transaction

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f290-...",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": null
}
```

| Field                                        | Rule                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Idempotency-Key` (header)                   | Required, up to 255 characters. Suggestion: `<providerId>:<externalTransactionId>`        |
| `providerId`                                 | Up to 64 characters; `system` is reserved                                                  |
| `externalTransactionId`, `roundId`, `gameId` | Up to 128 characters                                                                       |
| `playerId`, `walletId`                       | UUID                                                                                     |
| `kind`                                       | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`                                               |
| `money.amount`                               | Positive decimal string with up to 2 decimal places (`"25"`, `"25.5"`, `"25.00"`); never a JSON number |
| `money.currency`                             | ISO 4217, uppercase (`BRL`)                                                             |
| `referenceExternalTransactionId`             | Required for REFUND and ROLLBACK; optional for WIN; forbidden for BET and LOSS                |

The response body always has the same format:

```json
{
  "transactionId": "0192f298-...",
  "status": "PROCESSED",
  "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

| `status`            | HTTP | Meaning                                                                     |
| ------------------- | ---- | ------------------------------------------------------------------------------- |
| `PROCESSED`         | 200  | Applied (or LOSS recorded, without moving the balance)                                  |
| `PENDING_REFERENCE` | 202  | Accepted; the reference has not arrived yet. `balance` is `null`                       |
| `REJECTED`          | 422  | Business rejection, with `failureCode`. Resending the same request returns the same rejection |

`balance` is the balance **at the moment of the decision**, and replay returns exactly that value, even if the balance has changed since. For a pending transaction, resending the same request shows the current state: 202 while pending, and the outcome (200 or 422) once resolved.

### Errors

Errors that are not transaction outcomes use a single envelope:

```json
{ "error": { "code": "IDEMPOTENCY_KEY_REUSED", "message": "..." } }
```

For `VALIDATION_ERROR`, `error.details` lists the invalid fields (`[{ "field": "...", "message": "..." }]`), all at once.

| HTTP | Codes                                                                                                                                                                    | What to do                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 400  | `VALIDATION_ERROR`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `NON_POSITIVE_AMOUNT`, `OPENING_NOT_ALLOWED`, `RESERVED_PROVIDER`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED` | Fix the payload                                |
| 404  | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`                                                                                                                                | Check the ids                                   |
| 409  | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`, `DUPLICATE_TRANSACTION`                                                                                                 | Do not resend with different content                   |
| 503  | `TEMPORARILY_UNAVAILABLE` (with `Retry-After`)                                                                                                                              | Resend **the same** request; nothing was recorded |
| 500  | `INTERNAL_ERROR`                                                                                                                                                           | Investigate; resending the same request is safe  |

### Paginated ledger

```http
GET /wallets/:walletId/ledger?limit=50
```

```json
{
  "items": [
    {
      "id": "...",
      "transactionId": "...",
      "walletVersion": 1,
      "direction": "CREDIT",
      "money": { "amount": "1000.00", "currency": "BRL" },
      "balanceBefore": { "amount": "0.00", "currency": "BRL" },
      "balanceAfter": { "amount": "1000.00", "currency": "BRL" },
      "createdAt": "..."
    }
  ],
  "nextCursor": "eyJ2IjoxfQ"
}
```

`limit` ranges from 1 to 200 (default 50). Pass the received `nextCursor` for the next page; `null` indicates the end. The cursor is opaque and stable: new entries do not shift pages already read.

### Reconciliation

```http
POST /wallets/:walletId/reconciliation
```

```json
{
  "walletId": "...",
  "consistent": true,
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "walletVersion": 2,
  "checkedEntries": 2,
  "lastLedgerVersion": 2,
  "discrepancies": [],
  "checkedAt": "..."
}
```

A divergence also responds 200, with `consistent: false` and the list of `discrepancies` (`BALANCE_MISMATCH`, `LAST_ENTRY_MISMATCH`, `VERSION_MISMATCH`, `LEDGER_CHAIN_BROKEN`, `LEDGER_VERSION_GAP`). The balance is **never** corrected. See [Operation](#operação).

---

## Input via SQS queue

Queue: `wager-transactions.fifo`. Message:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "correlationId": "optional",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...",
    "walletId": "...",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" },
    "referenceExternalTransactionId": null
  }
}
```

| SQS attribute             | Recommended value                                              |
| ------------------------ | -------------------------------------------------------------- |
| `MessageGroupId`         | `walletId`: messages for the same wallet are processed in order |
| `MessageDeduplicationId` | `messageId`                                                    |

The message goes through the **same use case** as the API. FIFO queue deduplication is just an optimization: the guarantee is the persistent inbox keyed by `(consumer, messageId)`, written in the same transaction as the financial effect.

| Outcome                                                                                                    | Action                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Processed, pending or rejected for business reasons                                                               | Ack (`DeleteMessage`), always after the commit |
| Redelivery of an already processed message                                                                         | Ack, without repeating the effect                      |
| Invalid message, nonexistent wallet, idempotency conflict, `messageId` reused with different content | Immediate DLQ                                   |
| Transient failure (lock, database) or unexpected error                                                          | Retry with backoff (1 s, 2 s, 4 s... up to 60 s)  |
| Retry on attempt `SQS_MAX_RECEIVE_COUNT`                                                                  | DLQ with `RETRIES_EXHAUSTED`                    |

Messages in the DLQ carry the original body and the attributes `dlq-reason`, `dlq-detail`, `original-message-id` and `receive-count`.

---

## Published events

Queue: `wallet-events.fifo`. Each event is written to the outbox in the same transaction as the effect and published afterward, by the relay.

| Event                             | When                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | Transaction applied (including LOSS)                                             |
| `WagerTransactionRejected`         | Business rejection, including reference expiration                       |
| `WagerTransactionPendingReference` | Transaction awaiting the reference                                            |
| `WalletBalanceChanged`             | Every balance change, with `balanceBefore`, `balanceAfter` and `walletVersion` |

Envelope:

```json
{
  "eventId": "...",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "<walletId>",
  "correlationId": "...",
  "causationId": "...",
  "occurredAt": "...",
  "version": 1,
  "data": { "...": "..." }
}
```

| SQS attribute                | Value                                                 |
| --------------------------- | ----------------------------------------------------- |
| `MessageGroupId`            | `aggregateId` (`walletId`)                            |
| `MessageDeduplicationId`    | `eventId`                                             |
| `eventType`, `eventVersion` | message attributes, for filtering without opening the body |

**For consumers:** delivery is **at-least-once**. Deduplicate by `eventId`, and use `walletVersion` to order and discard stale events from the same wallet.

---

## Observability

Structured JSON logs (`correlationId`, `requestId`, `messageId`, `transactionId`, `walletId`,
`providerId` — never the full financial payload), separate health checks and Prometheus metrics
at `GET /metrics` (plain text, no authentication). Design details in
[ARCHITECTURE.en.md](ARCHITECTURE.en.md) (ADR-017).

```sh
curl -s localhost:3000/metrics
```

| Metric | Type | What it measures |
| --- | --- | --- |
| `wagering_transactions_total{status}` | counter | Transactions processed, by final status |
| `wagering_duplicates_detected_total{source}` | counter | Replay via `Idempotency-Key` (`idempotency_key`) or redelivery already seen in the inbox (`inbox_message`) |
| `sqs_message_retries_total` | counter | Messages returned to the queue with backoff |
| `sqs_dead_letter_messages_total{reason}` | counter | Messages sent to the DLQ, by reason |
| `database_lock_conflicts_total{sql_state}` | counter | `lock_timeout`/deadlock on the wallet (HTTP and SQS) |
| `outbox_publish_lag_seconds` | gauge | Delay between the event happening and being published |
| `http_request_duration_seconds{method,route,status}` | histogram | Latency of the entire HTTP API |
| `sqs_message_processing_duration_seconds{queue}` | histogram | Latency of processing each message |

---

## Business rules

### Transaction types

| Type       | Effect on balance               | Reference                          |
| ---------- | ----------------------------- | ------------------------------------ |
| `BET`      | Debit                        | Forbidden                            |
| `WIN`      | Credit                       | Optional (the round's BET)          |
| `LOSS`     | None (records the outcome) | Forbidden                            |
| `REFUND`   | Credit                       | Required: a BET                |
| `ROLLBACK` | The inverse of the reference       | Required: BET, WIN or REFUND     |
| `OPENING`  | Initial credit               | Internal: never accepted from providers |

A reference can only be reversed **once**, counting REFUND and ROLLBACK together. Reversals require the same amount, round, wallet, player, currency and provider as the reference.

### Out-of-order references

If the reference does not yet exist (or exists but is itself pending), the transaction becomes `PENDING_REFERENCE`:

- nothing is moved;
- new attempts with backoff (1 s, 2 s, 4 s... up to 60 s);
- when the reference arrives, the pending item is resolved immediately;
- after 15 minutes without the reference, it becomes `REJECTED` with `REFERENCE_NOT_FOUND`.

### Rejection codes (`failureCode`)

| Code                        | When                                                         | Provider action   |
| ----------------------------- | -------------------------------------------------------------- | ------------------ |
| `INSUFFICIENT_FUNDS`          | Debit greater than the balance                                       | Do not resend       |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK of a credit already spent                                | Escalate            |
| `CURRENCY_MISMATCH`           | Currency different from the wallet's                                      | Fix the payload |
| `WALLET_PLAYER_MISMATCH`      | The wallet belongs to another player (the balance is not exposed)      | Fix the payload |
| `REFERENCE_NOT_FOUND`         | Reference did not arrive within the deadline                          | Escalate            |
| `REFERENCE_CONTEXT_MISMATCH`  | Reference from another round, wallet, player, currency or provider | Fix the payload |
| `REFERENCE_INVALID_KIND`      | Reference type not allowed (e.g., REFUND of WIN)          | Fix the payload |
| `REFERENCE_NOT_PROCESSED`     | The reference was rejected                                     | Do not resend       |
| `REFERENCE_ALREADY_REVERSED`  | The reference already has a reversal                               | Do not resend       |
| `AMOUNT_MISMATCH`             | Reversal amount different from the reference                      | Fix the payload |
| `INFRA_RETRIES_EXHAUSTED`     | Permanent infrastructure failure after exhausting attempts  | Resend later    |

---

## Tests

All integration tests run against **real PostgreSQL and SQS** (LocalStack). Each suite uses its own database, copied from an already-migrated template, and its own queues, created and deleted by the suite: the tests never touch the `wagering` database or the development queues.

```bash
bun run infra:up           # required before integration tests
```

| Command                    | What it runs                                                             | Approximate time |
| -------------------------- | ---------------------------------------------------------------------- | ---------------- |
| `bun run typecheck`        | Type checking (Bun does not type-check at runtime)                  | seconds         |
| `bun run test:unit`        | Pure domain, no infrastructure                                       | < 1 s            |
| `bun run test:integration` | Schema, persistence, HTTP, consumer, relay, pending items, reconciliation | ~30 s            |
| `bun run test:concurrency` | Races in 1 process and in 3 separate processes                      | ~30 s            |
| `bun run test:resilience`  | Real processes killed (SIGKILL, SIGTERM)                          | ~1 min           |

### What the suites prove

| Suite         | Highlights                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema        | The database alone refuses negative balance, altered ledger (even by the owner), balance without an entry, double reversal, a third decimal place; reversible migrations                                                                                   |
| HTTP          | Every transaction type, replay with the balance at the time, 409 conflict, out-of-order reference                                                                                                                                    |
| Concurrency  | The same bet 50 times generates one debit; 100.00 with two bets of 80.00 ends with one PROCESSED and one REJECTED; the lock is per wallet, never global; all repeated across 3 processes                                                              |
| Consumer      | Inbox in the same transaction as the effect; redelivery with no duplicate effect; immediate DLQ for invalid messages; retry with recovery                                                                                                               |
| Relay         | 4 relays and 200 events with no loss or duplicates; relay killed before and after publishing                                                                                                                                                         |
| Pending items    | REFUND before the BET and ROLLBACK before the WIN resolved on their own; expiration; chains; 3 schedulers                                                                                                                                              |
| Reconciliation | Real corruptions detected, recorded and **not** corrected; no false divergence under load                                                                                                                                                 |
| Resilience   | SIGKILL between the commit and the ack; SIGTERM with a message in flight; exhaustion of attempts; relay and scheduler killed with another instance taking over; **full service restart under mixed load, with the exact final balance in every wallet** |

All suites that move balances end by verifying the final invariant across every wallet: `wallet.balance` = sum of the ledger.

### More repetitions and debugging

```bash
CONCURRENCY_ITERATIONS=50 bun test --timeout 300000 test/concurrency   # races repeated 50 times
MIKRO_ORM_DEBUG=true bun run test:integration                         # shows the queries
APP_LOGS=true bun test test/integration/messaging                     # Nest logs
APP_PROCESS_LOGS=true bun run test:resilience                         # child process logs
```

Resilience tests use fault-injection points (`FAULT_INJECTION=crash-after-commit-before-ack`, among others), which only act when the variable is set. In production the variable does not exist and these points do nothing.

---

## Operation

### Migrations

```bash
bun run migrate:status
bun run migrate:up
bun run migrate:down             # undoes only the last one
bun run migrate:create <name>    # empty migration, written by hand
```

Migrations are written by hand, because the schema uses features that the ORM's generator cannot express (domains, partial indexes, deferred constraint triggers, GRANTs). Every migration that creates a table must bring the corresponding `GRANT` for `wagering_app`.

### Reconciliation

```bash
# a single wallet
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# all wallets (exit 0 = consistent, 1 = divergence, 2 = execution failure)
bun run reconcile > divergencias.jsonl
```

The command prints one JSON line per divergent wallet and a summary line; logs go to stderr. It runs well as a scheduled job: exit code 1 is the alert.

A divergence is an **incident**: the balance must not be corrected without understanding the cause. When a fix is needed, do it with an auditable adjustment entry, never with an `UPDATE` on the balance (the triggers refuse it anyway).

Metrics recorded (exposed at `/metrics` as part of the observability layer):

| Metric                                            | Use                                     |
| -------------------------------------------------- | ---------------------------------------- |
| `wallet_reconciliation_divergences_total{code}`    | Alert: any increase is an incident |
| `wallet_reconciliation_checks_total{result}`       | Volume of checks                  |
| `wallet_reconciliation_last_run_wallets`           | Wallets checked in the last sweep |
| `wallet_reconciliation_last_run_divergent_wallets` | Divergent ones in the last sweep         |

### Useful queries

```bash
alias psql-wagering='docker compose exec postgres psql -U wagering_owner -d wagering'

# events not yet published and the oldest one (outbox lag)
psql-wagering -c "SELECT count(*), min(occurred_at) FROM outbox_messages WHERE published_at IS NULL"

# events with publishing failure
psql-wagering -c "SELECT id, event_type, attempts, last_error FROM outbox_messages
                  WHERE published_at IS NULL AND attempts > 0 ORDER BY occurred_at LIMIT 20"

# pending references and when they expire
psql-wagering -c "SELECT id, kind, reference_external_transaction_id, attempts, next_attempt_at, expires_at
                  FROM wager_transactions WHERE status = 'PENDING_REFERENCE' ORDER BY next_attempt_at"
```

### Dead-letter queue

```bash
DLQ=$(docker compose exec -T localstack awslocal sqs get-queue-url \
  --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)

docker compose exec -T localstack awslocal sqs receive-message --queue-url "$DLQ" \
  --max-number-of-messages 10 --message-attribute-names All --visibility-timeout 0
```

The `dlq-reason` attribute says why the message is there. After fixing the cause, resend the **original body** to the main queue: the inbox and idempotency guarantee that a message already applied is not applied again.

### Orphaned test databases

If a test run is interrupted (`Ctrl+C`), `wg_test_*` databases may be left behind:

```bash
docker compose exec postgres psql -U wagering_owner -d postgres -Atc \
  "SELECT 'DROP DATABASE ' || datname || ' WITH (FORCE);' FROM pg_database WHERE datname LIKE 'wg_test_%'" \
  | docker compose exec -T postgres psql -U wagering_owner -d postgres
```

---

## Project structure

```
src/
├── main.ts                      bootstrap: reads the environment and assembles the AppModule
├── app.module.ts                composition: persistence, messaging, auth, modules
├── shared/                      Money, domain errors, backoff, canonical hash, ports (Clock, IdGenerator, TransactionManager)
├── modules/
│   ├── wallet/                  Wallet, ledger, creation, queries, reconciliation
│   ├── wagering/                WagerTransaction, reference rules, central use case,
│   │                            HTTP, SQS consumer, pending-item scheduler
│   └── messaging/               inbox, outbox, relay, generic SQS consumer, publisher
├── infrastructure/persistence/  MikroORM, transaction, Postgres error mapping, migrations
└── platform/                    HTTP (parser, error filter), health, metrics, fault injection

scripts/
├── migrate.ts                   up | down | status | create
└── reconcile.ts                 reconciliation of all wallets

test/
├── unit/                        pure domain
├── integration/                 schema, persistence, HTTP, messaging, pending items, reconciliation
├── concurrency/                 1 process and 3 processes
├── resilience/                  real processes killed
└── support/                     per-suite database, per-suite queues, application processes, clients

docker/
├── postgres/init/01-roles.sql   runtime role (wagering_app)
└── localstack/init-sqs.sh       FIFO queues, DLQ and redrive policy
```

Each module follows the same division: `domain` (pure rules, no framework), `application` (use cases and ports) and `infrastructure` (adapters: HTTP, SQS, PostgreSQL).

---

## Troubleshooting

| Symptom                                                   | Cause                                             | Solution                                                                  |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `password authentication failed for user "wagering_app"`  | The Postgres volume predates `01-roles.sql` | `bun run infra:down` and `bun run infra:up`                                |
| `ECONNREFUSED 127.0.0.1:5432` or `:4566`                  | Infrastructure not running                         | `bun run infra:up`                                                       |
| LocalStack never becomes healthy                             | `init-sqs.sh` failed (permission or CRLF)        | `chmod +x docker/localstack/init-sqs.sh`; save with an LF line ending  |
| LocalStack asks for a token                                | Recent images require an account                     | Keep the pinned version `3.8` or use MiniStack                             |
| `permission denied for table ...` in the application            | New migration without `GRANT`                        | Add the `GRANT` to the migration                                       |
| `EADDRINUSE :3000`                                        | Two instances on the same port                    | Run the second one with `PORT=3001 bun src/main.ts` (or similar)             |
| 503 responses under load on the same wallet                 | Lock wait beyond 2 s                      | Expected: resend the same request; see the limitations below          |
| `[query] ...` logs everywhere                          | `MIKRO_ORM_DEBUG=true` in `.env`                  | Remove the line or set it to `false`                                          |
| `app process exited early` in multi-process tests      | The child process failed during boot                   | `APP_PROCESS_LOGS=true` shows the reason                                  |
| Integration test fails with a timeout on the first file | Template creation slower than the timeout      | Run via the script (`bun run test:integration`), which already uses a longer timeout |

---

## Known limitations

- **Throughput per wallet.** The pessimistic lock serializes operations on the same wallet: a few hundred per second per wallet. For a single player this is far more than needed; an account aggregating extreme volume would require subaccounts.
- **Event ordering across relays.** Different relays may publish events for the same wallet out of order. Events carry `walletVersion` so the consumer can order them.
- **At-least-once delivery.** A relay that dies between publishing and marking republishes the event with the same `eventId`. SQS FIFO deduplication (5 minutes) usually discards the copy; consumers should deduplicate by `eventId` regardless.
- **Instance clocks.** Relay and scheduler leases use each instance's own clock. Differences larger than the lease (10 to 30 s) could generate duplicate work, which is tolerated (idempotency and inbox).
- **No real authentication.** The structure (`ProviderIdentityPort`, `ProviderAuthGuard`, `CurrentProvider`, `AuthModule`) is ready and documented (ADR-008 in `ARCHITECTURE.en.md`), but the adapter wired in today (`AUTH_MODE=noop`) is fictitious and no controller uses the Guard yet — the `providerId` in the body remains unverified against the caller's identity.
- **Balance adjustments.** There is no auditable manual adjustment use case; reconciliation detects divergences, and the fix is an operational procedure.

Details, alternatives considered and justifications: [ARCHITECTURE.en.md](ARCHITECTURE.en.md).
