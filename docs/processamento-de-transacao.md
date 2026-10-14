# Processamento de uma transação de aposta

O fluxo central do sistema. `POST /wagering/transactions` (HTTP) e o consumo de
`wager-transactions.fifo` (SQS) chamam **o mesmo caso de uso** —
`ProcessWagerTransactionUseCase.execute()`
(`src/modules/wagering/application/use-cases/process-wager-transaction.use-case.ts`) — não existe
lógica de negócio duplicada entre os dois canais.

## Fluxo completo (caminho feliz: transação nova, PROCESSED)

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente HTTP / Consumer SQS
    participant Ctrl as WageringController / WagerMessageHandler
    participant UC as ProcessWagerTransactionUseCase
    participant TM as TransactionManager
    participant Wrepo as WalletRepository
    participant Settle as WagerSettlement
    participant Txrepo as WagerTransactionRepository
    participant Ledger as LedgerRepository
    participant Outbox as OutboxRepository
    participant DB as PostgreSQL

    C->>Ctrl: operação + Idempotency-Key (HTTP) ou messageId (SQS)
    Ctrl->>UC: execute(command, receipt?)
    UC->>UC: Money.from(command.money)
    UC->>UC: payloadHash = canonicalHash(campos de negócio)

    opt só HTTP — receipt === undefined: fast path sem lock
        UC->>Txrepo: findByIdempotencyKey(key)
        Note over Txrepo: se já existir, responde replay aqui<br/>e para (ver idempotência, abaixo)
    end

    UC->>TM: runInTransaction(...)
    activate TM
    opt só SQS — receipt presente
        UC->>DB: INSERT inbox_messages (consumerName, messageId)
        Note over DB: UNIQUE(consumer_name, message_id) já existe<br/>→ DuplicateMessageError (ver mensageria-sqs.md)
    end

    UC->>Wrepo: findByIdForUpdate(walletId)
    Wrepo->>DB: SELECT ... FOR UPDATE
    Note over DB: lock_timeout próprio da transação,<br/>esgotado → 503 (ver concorrencia.md)
    DB-->>Wrepo: linha travada até o commit
    Wrepo-->>UC: wallet (404 WALLET_NOT_FOUND se não existir)

    UC->>Txrepo: findByIdempotencyKey(key) — re-checagem SOB o lock
    Note over Txrepo: quem esperou o lock pode ter perdido<br/>a corrida pra mesma key

    UC->>UC: WagerTransaction.create(...) — nasce PENDING
    UC->>Settle: decide(tx, wallet, now, onReferenceUnavailable)
    Note over Settle: regras por kind, resolução de referência —<br/>ver regras-de-liquidacao.md
    Settle-->>UC: WalletLedgerEntry | undefined

    opt saldo mudou (entry !== undefined)
        UC->>Wrepo: update(wallet, expectedVersion)
        Note over DB: version não bate → lost update<br/>detectado (ver concorrencia.md)
    end
    UC->>Txrepo: insert(tx)
    Note over DB: UNIQUE(idempotency_key) violada por outra<br/>transação concorrente → corrida (ver abaixo)
    opt saldo mudou
        UC->>Ledger: append(entry)
    end
    UC->>Outbox: enqueue(eventos do desfecho)
    deactivate TM

    UC-->>Ctrl: TransactionResult { status, balance, idempotentReplay: false }
    Ctrl-->>C: 200 PROCESSED / 202 PENDING(_REFERENCE) / 422 REJECTED / 500 FAILED
```

## Idempotência: replay vs. corrida vs. conflito

```mermaid
flowchart TD
    Start(["chave + payload chegam"]) --> Fast{"fast path (só HTTP):<br/>key já existe?"}
    Fast -- "sim, hash igual" --> Replay["replay:<br/>idempotentReplay=true,<br/>devolve resultado e saldo da época"]
    Fast -- "sim, hash diferente" --> Conflict["409 IDEMPOTENCY_KEY_REUSED"]
    Fast -- "não (ou é SQS)" --> Lock["lock da wallet + re-checagem"]
    Lock -- "apareceu entre a checagem<br/>e o lock" --> Replay
    Lock -- "ainda não existe" --> Insert["processUnderLock: cria e insere"]
    Insert -- "INSERT ok" --> Done(["resultado novo"])
    Insert -- "UNIQUE(idempotency_key)<br/>violada" --> Race["outra wallet venceu a corrida<br/>(lock diferente, key igual)"]
    Race --> Reread["relê a transação pela key,<br/>numa transação curta nova"]
    Reread -- "hash igual" --> Replay
    Reread -- "hash diferente" --> Conflict
```

Esse último ramo (`Race`) é o único jeito de duas requisições com a **mesma key** mas
**wallets diferentes** colidirem: como o lock é por wallet, elas não disputam o mesmo lock —
quem commita primeiro grava a key; a outra recebe `DuplicateWagerTransactionError` do banco
(`UNIQUE(idempotency_key)`), relê numa transação nova e decide replay ou conflito. Ver
`ARCHITECTURE.md` (ADR-011) para o algoritmo exato do `payloadHash`.

## Diferenças entre o canal HTTP e o canal SQS

| | HTTP | SQS |
|---|---|---|
| Identidade da requisição | `Idempotency-Key` (header) | `messageId` do envelope |
| Fast path sem lock | Sim | Não — sempre entra na transação (precisa gravar a inbox de qualquer forma) |
| Registro de deduplicação | Só a `UNIQUE(idempotency_key)` | Inbox (`consumerName`, `messageId`) **e** a idempotency key |
| Confirmação pro chamador | Resposta HTTP síncrona | `ack` **só depois do commit** (ver [mensageria-sqs.md](./mensageria-sqs.md)) |
| Reentrega | Cliente decide reenviar | SQS reentrega sozinho; a inbox garante que o efeito não duplica |

## Arquivos

- `src/modules/wagering/application/use-cases/process-wager-transaction.use-case.ts` — orquestração.
- `src/modules/wagering/application/use-cases/payload-hash.ts` + `src/shared/util/canonical-hash.ts` — `payloadHash`.
- `src/modules/wagering/presentation/controllers/wagering.controller.ts` — entrada HTTP.
- `src/modules/wagering/infrastructure/sqs/wager-message.handler.ts` — entrada SQS.
