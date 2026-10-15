# Observability: health checks and metrics

## `/health/live` vs. `/health/ready`

```mermaid
flowchart LR
    subgraph Live["GET /health/live"]
        L1["did the process respond?"] --> L2["200 { status: ok }"]
        Note1["never checks a dependency —<br/>if it fails, the orchestrator RESTARTS the process"]
    end

    subgraph Ready["GET /health/ready"]
        R1["checks Postgres and SQS<br/>IN PARALLEL"] --> R2{"both ok?"}
        R2 -- yes --> R3["200 { status: ok,<br/>checks: { postgres: ok, sqs: ok } }"]
        R2 -- no --> R4["503 { status: error,<br/>checks: { ...detail of what failed } }"]
        Note2["if it fails, the orchestrator takes the instance<br/>out of the load balancer WITHOUT killing the process —<br/>it comes back on its own when the dependency recovers"]
    end
```

```mermaid
sequenceDiagram
    participant LB as Orchestrator
    participant H as HealthController
    participant PG as MikroORM
    participant SQS as SQSClient

    LB->>H: GET /health/ready
    par in parallel
        H->>PG: isConnected()
    and
        H->>SQS: GetQueueUrlCommand(wallet-events.fifo)
    end
    PG-->>H: ok / error
    SQS-->>H: ok / error (AggregateError flattened into readable text)
    H-->>LB: 200 (both ok) or 503 (either one failed)
```

If the instance has no role that uses the queue (SQS not configured), the SQS check becomes
`"skipped"` instead of failing — it is not treated as unavailability.

## `/metrics` (Prometheus)

```mermaid
flowchart TD
    subgraph Emissão["where each metric originates"]
        M1["ProcessWagerTransactionUseCase.execute()"] -->|"wagering_transactions_total{status}<br/>wagering_duplicates_detected_total{source=idempotency_key}"| Registry
        M2["WagerMessageHandler.classify()"] -->|"wagering_duplicates_detected_total{source=inbox_message}<br/>database_lock_conflicts_total"| Registry
        M3["SqsPollingConsumer.apply()/dispatch()"] -->|"sqs_message_retries_total<br/>sqs_dead_letter_messages_total<br/>sqs_message_processing_duration_seconds"| Registry
        M4["OutboxRelay.relayOnce()"] -->|"outbox_publish_lag_seconds"| Registry
        M5["ErrorMappingFilter"] -->|"database_lock_conflicts_total (HTTP path)"| Registry
        M6["HttpMetricsInterceptor"] -->|"http_request_duration_seconds"| Registry
        M7["LoggingReconciliationAlerts"] -->|"wallet_reconciliation_checks_total<br/>wallet_reconciliation_divergences_total"| Registry
    end
    Registry[("InMemoryMetrics<br/>(counter · gauge · histogram)")] --> Scrape["GET /metrics"]
    Scrape --> Format["formatPrometheusText():<br/># TYPE + samples, histogram with<br/>cumulative buckets up to +Inf"]
    Format --> Prom["Prometheus scraper"]
```

| Metric | Type | What it tells you |
|---|---|---|
| `wagering_transactions_total{status}` | counter | volume by outcome |
| `wagering_duplicates_detected_total{source}` | counter | actual resend/redelivery happening |
| `sqs_message_retries_total` / `sqs_dead_letter_messages_total{reason}` | counter | consumer health; `reason` points to the cause |
| `database_lock_conflicts_total{sql_state}` | counter | real contention (hot wallet) |
| `outbox_publish_lag_seconds` | gauge | relay's delay in publishing what is already committed |
| `http_request_duration_seconds` / `sqs_message_processing_duration_seconds` | histogram | end-to-end latency, per route/queue |

## Files

- `src/platform/health/health.controller.ts`
- `src/platform/observability/metrics.ts`, `metrics.controller.ts`, `prometheus-format.ts`,
  `http-metrics.interceptor.ts`
- `test/integration/observability/metrics.test.ts`
