# Mensageria SQS: consumo, retry e DLQ

`SqsPollingConsumer` (`src/modules/messaging/infrastructure/sqs/sqs-polling-consumer.ts`) é
genérico — quem decide o que fazer com cada mensagem é o `handle` injetado, que pra
`wager-transactions.fifo` é o `WagerMessageHandler`
(`src/modules/wagering/infrastructure/sqs/wager-message.handler.ts`), chamando o **mesmo**
`ProcessWagerTransactionUseCase` da API HTTP.

## Loop de consumo

```mermaid
flowchart TD
    Receive["ReceiveMessageCommand<br/>(long polling)"] --> Group["agrupa por MessageGroupId<br/>(= walletId)"]
    Group --> Parallel["grupos diferentes em paralelo;<br/>mesma wallet em sequência"]
    Parallel --> Dispatch["dispatch(message):<br/>handle(body) → disposition"]
    Dispatch --> Exhausted{"disposition=retry e<br/>receiveCount >= maxReceiveCount?"}
    Exhausted -- sim --> ForceDLQ["vira dead-letter<br/>(RETRIES_EXHAUSTED)"]
    Exhausted -- não --> Apply["apply(disposition)"]
    ForceDLQ --> Apply
    Apply -- ack --> Delete["DeleteMessage"]
    Apply -- retry --> ChangeVis["ChangeMessageVisibility<br/>(backoff exponencial)<br/>+ devolve o resto do grupo,<br/>preservando a ordem"]
    Apply -- dead-letter --> SendDLQ["SendMessage na DLQ<br/>(com motivo e detalhe)<br/>+ DeleteMessage da fila principal"]
```

## Como o handler classifica cada erro (`WagerMessageHandler.classify`)

```mermaid
flowchart TD
    Err(["erro lançado por<br/>ProcessWagerTransactionUseCase.execute()"]) --> IsDup{"DuplicateMessageError?<br/>(inbox já tem este messageId)"}
    IsDup -- sim --> Lookup["relê a inbox: o payload bate<br/>com o que já foi processado?"]
    Lookup -- sim --> Ack["ack · duplicate<br/>(reentrega inofensiva)"]
    Lookup -- não --> DLQ1["dead-letter · MESSAGE_ID_REUSED<br/>(mesmo messageId, payload diferente)"]
    Lookup -- "a própria releitura falhou" --> Retry1["retry · inbox lookup failed"]

    IsDup -- não --> IsDomain{"DomainError?<br/>(payload inválido, wallet<br/>inexistente, conflito de key)"}
    IsDomain -- sim --> DLQ2["dead-letter · error.code<br/>(reenviar não muda nada)"]

    IsDomain -- não --> IsTransient{"isTransientDatabaseError?<br/>(lock_timeout, deadlock, conexão)"}
    IsTransient -- sim --> LockMetric["se for lock_timeout/deadlock:<br/>database_lock_conflicts_total++"]
    LockMetric --> Retry2["retry · transient<br/>(pode dar certo depois)"]

    IsTransient -- não --> Retry3["retry · unexpected<br/>(bug ou erro desconhecido;<br/>limitado pelo maxReceiveCount)"]
```

## `SIGTERM`: termina o que está em andamento, devolve o resto

```mermaid
sequenceDiagram
    participant OS as Orquestrador (SIGTERM)
    participant App as WagerTransactionsConsumer
    participant Poll as loop de consumo
    participant SQS as Fila

    OS->>App: beforeApplicationShutdown()
    App->>Poll: stopping = true, aborta o ReceiveMessage em andamento
    Note over Poll: mensagens JÁ em processamento continuam<br/>até terminar (até shutdownTimeoutMs)
    Poll->>SQS: mensagens NÃO iniciadas do lote atual:<br/>ChangeVisibility(0) — devolve imediatamente
    Poll-->>App: loop termina (ou timeout — log de aviso,<br/>mensagem reaparece sozinha depois do visibility timeout)
```

## Pontos importantes

- **Ack só depois do commit**: o `handle` do consumer só devolve `ack` depois que
  `ProcessWagerTransactionUseCase.execute()` já retornou com sucesso — e isso só acontece depois
  do `COMMIT` da transação SQL. Matar o processo entre o commit e o ack (testado com `SIGKILL`
  real em `test/resilience/consumer-failures.test.ts`) é seguro: a mensagem reaparece, a inbox
  já tem o `messageId` processado, e o handler devolve `ack · duplicate` sem reaplicar o efeito.
- **Ordem preservada por grupo**: um `retry` numa mensagem devolve o **resto do mesmo grupo**
  (mesma wallet) pra fila também, em vez de processá-las fora de ordem.
- **DLQ carrega o motivo**: `dlq-reason` e `dlq-detail` vão como atributos da mensagem — quem
  olha a DLQ sabe por que aquela mensagem está lá sem precisar cruzar com log.

## Arquivos

- `src/modules/messaging/infrastructure/sqs/sqs-polling-consumer.ts` — loop genérico.
- `src/modules/wagering/infrastructure/sqs/wager-message.handler.ts` — classificação específica
  do domínio de wagering.
- `src/modules/wagering/infrastructure/sqs/wager-transactions.consumer.ts` — liga os dois,
  só nas instâncias com o papel `consumer`.
- `test/resilience/consumer-failures.test.ts` — `SIGKILL`/`SIGTERM` reais.
