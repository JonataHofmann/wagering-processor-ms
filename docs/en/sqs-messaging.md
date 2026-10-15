# SQS messaging: consumption, retry, and DLQ

`SqsPollingConsumer` (`src/modules/messaging/infrastructure/sqs/sqs-polling-consumer.ts`) is
generic — what decides what to do with each message is the injected `handle`, which for
`wager-transactions.fifo` is the `WagerMessageHandler`
(`src/modules/wagering/infrastructure/sqs/wager-message.handler.ts`), calling the **same**
`ProcessWagerTransactionUseCase` as the HTTP API.

## Consumption loop

```mermaid
flowchart TD
    Receive["ReceiveMessageCommand<br/>(long polling)"] --> Group["groups by MessageGroupId<br/>(= walletId)"]
    Group --> Parallel["different groups in parallel;<br/>same wallet in sequence"]
    Parallel --> Dispatch["dispatch(message):<br/>handle(body) → disposition"]
    Dispatch --> Exhausted{"disposition=retry and<br/>receiveCount >= maxReceiveCount?"}
    Exhausted -- yes --> ForceDLQ["becomes dead-letter<br/>(RETRIES_EXHAUSTED)"]
    Exhausted -- no --> Apply["apply(disposition)"]
    ForceDLQ --> Apply
    Apply -- ack --> Delete["DeleteMessage"]
    Apply -- retry --> ChangeVis["ChangeMessageVisibility<br/>(exponential backoff)<br/>+ returns the rest of the group,<br/>preserving order"]
    Apply -- dead-letter --> SendDLQ["SendMessage to the DLQ<br/>(with reason and detail)<br/>+ DeleteMessage from the main queue"]
```

## How the handler classifies each error (`WagerMessageHandler.classify`)

```mermaid
flowchart TD
    Err(["error thrown by<br/>ProcessWagerTransactionUseCase.execute()"]) --> IsDup{"DuplicateMessageError?<br/>(inbox already has this messageId)"}
    IsDup -- yes --> Lookup["rereads the inbox: does the payload match<br/>what was already processed?"]
    Lookup -- yes --> Ack["ack · duplicate<br/>(harmless redelivery)"]
    Lookup -- no --> DLQ1["dead-letter · MESSAGE_ID_REUSED<br/>(same messageId, different payload)"]
    Lookup -- "the reread itself failed" --> Retry1["retry · inbox lookup failed"]

    IsDup -- no --> IsDomain{"DomainError?<br/>(invalid payload, wallet<br/>does not exist, key conflict)"}
    IsDomain -- yes --> DLQ2["dead-letter · error.code<br/>(resending changes nothing)"]

    IsDomain -- no --> IsTransient{"isTransientDatabaseError?<br/>(lock_timeout, deadlock, connection)"}
    IsTransient -- yes --> LockMetric["if lock_timeout/deadlock:<br/>database_lock_conflicts_total++"]
    LockMetric --> Retry2["retry · transient<br/>(might succeed later)"]

    IsTransient -- no --> Retry3["retry · unexpected<br/>(bug or unknown error;<br/>bounded by maxReceiveCount)"]
```

## `SIGTERM`: finishes what is in progress, returns the rest

```mermaid
sequenceDiagram
    participant OS as Orchestrator (SIGTERM)
    participant App as WagerTransactionsConsumer
    participant Poll as consumption loop
    participant SQS as Queue

    OS->>App: beforeApplicationShutdown()
    App->>Poll: stopping = true, aborts the in-flight ReceiveMessage
    Note over Poll: messages ALREADY being processed continue<br/>until finished (up to shutdownTimeoutMs)
    Poll->>SQS: messages NOT yet started from the current batch:<br/>ChangeVisibility(0) — returns them immediately
    Poll-->>App: loop ends (or timeout — warning log,<br/>message reappears on its own after the visibility timeout)
```

## Important points

- **Ack only after commit**: the consumer's `handle` only returns `ack` after
  `ProcessWagerTransactionUseCase.execute()` has already returned successfully — and that only
  happens after the SQL transaction's `COMMIT`. Killing the process between the commit and the ack
  (tested with a real `SIGKILL` in `test/resilience/consumer-failures.test.ts`) is safe: the
  message reappears, the inbox already has the `messageId` processed, and the handler returns
  `ack · duplicate` without reapplying the effect.
- **Order preserved per group**: a `retry` on one message also returns the **rest of the same
  group** (same wallet) to the queue, instead of processing them out of order.
- **DLQ carries the reason**: `dlq-reason` and `dlq-detail` go as message attributes — whoever
  looks at the DLQ knows why that message is there without having to cross-reference logs.

## Files

- `src/modules/messaging/infrastructure/sqs/sqs-polling-consumer.ts` — generic loop.
- `src/modules/wagering/infrastructure/sqs/wager-message.handler.ts` — classification specific
  to the wagering domain.
- `src/modules/wagering/infrastructure/sqs/wager-transactions.consumer.ts` — wires the two
  together, only on instances with the `consumer` role.
- `test/resilience/consumer-failures.test.ts` — real `SIGKILL`/`SIGTERM`.
