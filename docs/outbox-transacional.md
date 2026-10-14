# Outbox transacional e o relay

O evento de integração nasce como **linha na tabela `outbox`**, gravado na mesma transação SQL
do efeito financeiro (ver [processamento-de-transacao.md](./processamento-de-transacao.md)) —
nunca é publicado na hora. Um worker separado, o `OutboxRelay`
(`src/modules/messaging/application/use-cases/outbox-relay.ts`), publica depois, fora da
transação, e pode haver **vários publishers concorrentes** sem perder nem duplicar
indefinidamente.

## Uma rodada do relay

```mermaid
sequenceDiagram
    autonumber
    participant Relay as OutboxRelay
    participant DB as PostgreSQL
    participant SQS as wallet-events.fifo

    Relay->>DB: UPDATE outbox SET locked_by=owner, lease_until=now+leaseMs<br/>WHERE pending FOR UPDATE SKIP LOCKED LIMIT batchSize
    Note over DB: SKIP LOCKED: outro relay rodando ao mesmo<br/>tempo pega outras linhas, nunca as mesmas
    DB-->>Relay: lote reservado (commit da reserva)

    Relay->>SQS: SendMessageBatch (FORA de transação —<br/>nenhuma conexão presa durante I/O de rede)
    SQS-->>Relay: sucesso/falha por mensagem

    Relay->>DB: nova transação curta:
    loop cada mensagem do lote
        alt publicada com sucesso
            Relay->>DB: markPublished(now)<br/>+ lag = now - occurredAt
        else falhou
            Relay->>DB: scheduleRetry(now)<br/>(backoff: 1s .. 5min, equal jitter)
        end
    end
    Relay->>Relay: outbox_publish_lag_seconds =<br/>maior lag do lote
```

## Cenário de crash (o exigido pelo enunciado)

```mermaid
sequenceDiagram
    participant A as Relay A
    participant DB as PostgreSQL
    participant SQS as wallet-events.fifo
    participant B as Relay B (outra instância)

    A->>DB: reserva o lote (lease = agora + 30s)
    Note over A: processo morre aqui —<br/>antes OU depois de publicar, não importa
    A--xA: 💥 SIGKILL

    Note over DB: lease expira depois de 30s:<br/>a linha volta a ser "pending" pra quem quiser

    B->>DB: reserva o MESMO lote (lease vencida de A)
    B->>SQS: publica de novo
    Note over SQS: se A já tinha publicado antes de morrer,<br/>isso é uma publicação DUPLICADA — seguro por design:<br/>MessageDeduplicationId=eventId, FIFO deduplica 5 min,<br/>e o consumidor downstream deduplica por eventId de qualquer forma
    B->>DB: markPublished(now)
```

Entrega **at-least-once**, nunca at-most-once — perder um evento confirmado é uma falha
eliminatória do enunciado; publicá-lo duas vezes é uma consequência aceita e tratada.

## Os 4 eventos mínimos

| Evento | Quando | Carrega |
|---|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, **inclusive `LOSS`** | resumo da transação |
| `WagerTransactionRejected` | rejeitada por regra de negócio | `failureCode` |
| `WalletBalanceChanged` | **somente** quando o saldo muda (nunca em `LOSS`) | saldo antes/depois, direção, `walletVersion` |
| `WagerTransactionPendingReference` | referência ausente na primeira tentativa | — |

Todos são subclasses concretas de `IntegrationEvent<T>` (`src/shared/domain/integration-event.ts`)
— `eventType`/`version` ficam **no tipo**, nunca uma string solta no call site — e o `data`
carrega sempre `MoneyProps` (string), nunca a instância de `Money`.

## Arquivos

- `src/modules/messaging/application/use-cases/outbox-relay.ts` — a lógica da rodada.
- `src/modules/messaging/infrastructure/relay/outbox-relay.worker.ts` — o loop, só nas instâncias
  com o papel `relay`.
- `src/modules/messaging/infrastructure/sqs/sqs-event-publisher.ts` — publicação de verdade (SQS).
- `src/modules/wagering/domain/events/*.event.ts` — as 4 subclasses de evento.
- `test/integration/messaging/outbox-relay.test.ts` — múltiplos publishers concorrentes, in-process.
- `test/resilience/relay-failures.test.ts` — o cenário de crash, com `SIGKILL` real em 3 processos.
