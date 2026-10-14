# Observabilidade: health checks e métricas

## `/health/live` vs. `/health/ready`

```mermaid
flowchart LR
    subgraph Live["GET /health/live"]
        L1["processo respondeu?"] --> L2["200 { status: ok }"]
        Note1["nunca consulta dependência —<br/>se falhar, o orquestrador REINICIA o processo"]
    end

    subgraph Ready["GET /health/ready"]
        R1["checa Postgres e SQS<br/>EM PARALELO"] --> R2{"os dois ok?"}
        R2 -- sim --> R3["200 { status: ok,<br/>checks: { postgres: ok, sqs: ok } }"]
        R2 -- não --> R4["503 { status: error,<br/>checks: { ...detalhe do que falhou } }"]
        Note2["se falhar, o orquestrador tira a instância<br/>do load balancer SEM matar o processo —<br/>ela volta sozinha quando a dependência volta"]
    end
```

```mermaid
sequenceDiagram
    participant LB as Orquestrador
    participant H as HealthController
    participant PG as MikroORM
    participant SQS as SQSClient

    LB->>H: GET /health/ready
    par em paralelo
        H->>PG: isConnected()
    and
        H->>SQS: GetQueueUrlCommand(wallet-events.fifo)
    end
    PG-->>H: ok / erro
    SQS-->>H: ok / erro (AggregateError achatado em texto legível)
    H-->>LB: 200 (os dois ok) ou 503 (qualquer um falhou)
```

Se a instância não tiver papel que use fila (SQS não configurado), o check de SQS vira
`"skipped"` em vez de falhar — não é tratado como indisponibilidade.

## `/metrics` (Prometheus)

```mermaid
flowchart TD
    subgraph Emissão["onde cada métrica nasce"]
        M1["ProcessWagerTransactionUseCase.execute()"] -->|"wagering_transactions_total{status}<br/>wagering_duplicates_detected_total{source=idempotency_key}"| Registry
        M2["WagerMessageHandler.classify()"] -->|"wagering_duplicates_detected_total{source=inbox_message}<br/>database_lock_conflicts_total"| Registry
        M3["SqsPollingConsumer.apply()/dispatch()"] -->|"sqs_message_retries_total<br/>sqs_dead_letter_messages_total<br/>sqs_message_processing_duration_seconds"| Registry
        M4["OutboxRelay.relayOnce()"] -->|"outbox_publish_lag_seconds"| Registry
        M5["ErrorMappingFilter"] -->|"database_lock_conflicts_total (caminho HTTP)"| Registry
        M6["HttpMetricsInterceptor"] -->|"http_request_duration_seconds"| Registry
        M7["LoggingReconciliationAlerts"] -->|"wallet_reconciliation_checks_total<br/>wallet_reconciliation_divergences_total"| Registry
    end
    Registry[("InMemoryMetrics<br/>(contador · gauge · histograma)")] --> Scrape["GET /metrics"]
    Scrape --> Format["formatPrometheusText():<br/># TYPE + amostras, histograma com<br/>buckets cumulativos até +Inf"]
    Format --> Prom["scraper Prometheus"]
```

| Métrica | Tipo | O que diz |
|---|---|---|
| `wagering_transactions_total{status}` | counter | volume por desfecho |
| `wagering_duplicates_detected_total{source}` | counter | reenvio/reentrega de verdade acontecendo |
| `sqs_message_retries_total` / `sqs_dead_letter_messages_total{reason}` | counter | saúde do consumer; `reason` aponta a causa |
| `database_lock_conflicts_total{sql_state}` | counter | contenção real (hot wallet) |
| `outbox_publish_lag_seconds` | gauge | atraso do relay em publicar o que já está confirmado |
| `http_request_duration_seconds` / `sqs_message_processing_duration_seconds` | histogram | latência ponta a ponta, por rota/fila |

## Arquivos

- `src/platform/health/health.controller.ts`
- `src/platform/observability/metrics.ts`, `metrics.controller.ts`, `prometheus-format.ts`,
  `http-metrics.interceptor.ts`
- `test/integration/observability/metrics.test.ts`
