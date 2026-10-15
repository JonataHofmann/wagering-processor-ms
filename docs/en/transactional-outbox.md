# Transactional outbox and the relay

The integration event is born as a **row in the `outbox` table**, written in the same SQL
transaction as the financial effect (see [transaction-processing.md](./transaction-processing.md)) —
it is never published right away. A separate worker, the `OutboxRelay`
(`src/modules/messaging/application/use-cases/outbox-relay.ts`), publishes it later, outside the
transaction, and there can be **several concurrent publishers** without losing or indefinitely
duplicating events.

## One relay round

```mermaid
sequenceDiagram
    autonumber
    participant Relay as OutboxRelay
    participant DB as PostgreSQL
    participant SQS as wallet-events.fifo

    Relay->>DB: UPDATE outbox SET locked_by=owner, lease_until=now+leaseMs<br/>WHERE pending FOR UPDATE SKIP LOCKED LIMIT batchSize
    Note over DB: SKIP LOCKED: another relay running at the same<br/>time picks up other rows, never the same ones
    DB-->>Relay: reserved batch (reservation committed)

    Relay->>SQS: SendMessageBatch (OUTSIDE the transaction —<br/>no connection held during network I/O)
    SQS-->>Relay: success/failure per message

    Relay->>DB: new short transaction:
    loop each message in the batch
        alt published successfully
            Relay->>DB: markPublished(now)<br/>+ lag = now - occurredAt
        else failed
            Relay->>DB: scheduleRetry(now)<br/>(backoff: 1s .. 5min, equal jitter)
        end
    end
    Relay->>Relay: outbox_publish_lag_seconds =<br/>largest lag in the batch
```

## Crash scenario (the one required by the spec)

```mermaid
sequenceDiagram
    participant A as Relay A
    participant DB as PostgreSQL
    participant SQS as wallet-events.fifo
    participant B as Relay B (another instance)

    A->>DB: reserves the batch (lease = now + 30s)
    Note over A: process dies here —<br/>before OR after publishing, doesn't matter
    A--xA: 💥 SIGKILL

    Note over DB: lease expires after 30s:<br/>the row goes back to "pending" for whoever wants it

    B->>DB: reserves the SAME batch (A's expired lease)
    B->>SQS: publishes again
    Note over SQS: if A had already published before dying,<br/>this is a DUPLICATE publish — safe by design:<br/>MessageDeduplicationId=eventId, FIFO deduplicates for 5 min,<br/>and the downstream consumer deduplicates by eventId anyway
    B->>DB: markPublished(now)
```

Delivery is **at-least-once**, never at-most-once — losing a confirmed event is a disqualifying
failure per the spec; publishing it twice is an accepted and handled consequence.

## The 4 minimum events

| Event | When | Carries |
|---|---|---|
| `WagerTransactionProcessed` | any applied transaction, **including `LOSS`** | transaction summary |
| `WagerTransactionRejected` | rejected by a business rule | `failureCode` |
| `WalletBalanceChanged` | **only** when the balance changes (never on `LOSS`) | balance before/after, direction, `walletVersion` |
| `WagerTransactionPendingReference` | reference missing on the first attempt | — |

All of these are concrete subclasses of `IntegrationEvent<T>` (`src/shared/domain/integration-event.ts`)
— `eventType`/`version` live **in the type**, never a loose string at the call site — and `data`
always carries `MoneyProps` (string), never the `Money` instance.

## Files

- `src/modules/messaging/application/use-cases/outbox-relay.ts` — the round's logic.
- `src/modules/messaging/infrastructure/relay/outbox-relay.worker.ts` — the loop, only on instances
  with the `relay` role.
- `src/modules/messaging/infrastructure/sqs/sqs-event-publisher.ts` — the actual publishing (SQS).
- `src/modules/wagering/domain/events/*.event.ts` — the 4 event subclasses.
- `test/integration/messaging/outbox-relay.test.ts` — multiple concurrent publishers, in-process.
- `test/resilience/relay-failures.test.ts` — the crash scenario, with a real `SIGKILL` across 3 processes.
