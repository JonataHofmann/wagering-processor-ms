# Distributed Wagering Processor

Serviço que processa transações financeiras de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de provedores de jogos, por **HTTP** e por **fila SQS**, mantendo a carteira de cada jogador consistente sob concorrência, reentrega de mensagens, falhas parciais e múltiplas instâncias.

O princípio de projeto é simples: **nenhuma garantia financeira depende de uma única camada.** O domínio decide, o lock serializa, a idempotência é persistente, e o próprio PostgreSQL recusa (por constraints, triggers e permissões) qualquer estado em que o saldo divirja do ledger.

As decisões de arquitetura, alternativas e trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Sumário

1. [Estado atual](#estado-atual)
2. [O que o sistema garante](#o-que-o-sistema-garante)
3. [Stack](#stack)
4. [Arquitetura em um minuto](#arquitetura-em-um-minuto)
5. [Pré-requisitos](#pré-requisitos)
6. [Início rápido](#início-rápido)
7. [Rodando com 3 réplicas](#rodando-com-3-réplicas)
8. [Configuração](#configuração)
9. [API HTTP](#api-http)
10. [Entrada pela fila SQS](#entrada-pela-fila-sqs)
11. [Eventos publicados](#eventos-publicados)
12. [Regras de negócio](#regras-de-negócio)
13. [Papéis da instância](#papéis-da-instância)
14. [Testes](#testes)
15. [Operação](#operação)
16. [Estrutura do projeto](#estrutura-do-projeto)
17. [Solução de problemas](#solução-de-problemas)
18. [Limitações conhecidas](#limitações-conhecidas)

---

## Estado atual

| Área                                                                     | Status                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Schema com constraints, triggers de integridade e permissões mínimas     | ✓                                                                     |
| Domínio: `Money` exato, `Wallet`, `WagerTransaction`, ledger imutável    | ✓                                                                     |
| API HTTP com idempotência persistente (`Idempotency-Key`)                | ✓                                                                     |
| Lock pessimista por wallet; testes de concorrência em 1 e em 3 processos | ✓                                                                     |
| Consumer SQS com inbox transacional, retry com backoff e DLQ             | ✓                                                                     |
| Transactional outbox com relay concorrente (lease + `SKIP LOCKED`)       | ✓                                                                     |
| Referências fora de ordem (`PENDING_REFERENCE`, backoff, TTL, scheduler) | ✓                                                                     |
| Reconciliação saldo × ledger (endpoint e comando)                        | ✓                                                                     |
| Testes de resiliência com processos reais (SIGKILL, SIGTERM)             | ✓                                                                     |
| Teste de reinício sob carga com prova de consistência final              | ✓                                                                     |
| Observabilidade: logs JSON, `/metrics` (Prometheus), `/health/ready`     | Em andamento (métricas já contadas em memória; `/health/live` e `/health/ready` prontos) |
| Autenticação de provedores                                               | Estrutura pronta via `ProviderIdentityPort`/`AuthModule` (ADR-008); adapter é no-op, integração real com Keycloak pendente |

---

## O que o sistema garante

| Garantia                                                  | Como                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Dinheiro nunca é `number`                                 | `Money` encapsula `decimal.js`; no banco, o domínio `money_amount` **rejeita** (não arredonda) uma terceira casa decimal               |
| Saldo nunca negativo, nem sob corrida                     | Lock `SELECT ... FOR UPDATE` por wallet + `CHECK` no banco                                                                             |
| Nenhum débito ou crédito duplicado                        | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, re-checagem sob o lock, inbox por `(consumer, messageId)` |
| Repetir uma requisição devolve o resultado original       | Toda decisão (inclusive rejeição) é gravada com o saldo observado; o replay lê a transação gravada                                     |
| Mesma `Idempotency-Key` com conteúdo diferente é conflito | `payloadHash` (SHA-256 de JSON canônico RFC 8785) → `409 IDEMPOTENCY_KEY_REUSED`                                                       |
| Saldo, ledger, transação, inbox e outbox são atômicos     | Uma única transação SQL por operação; triggers deferidos conferem a coerência no `COMMIT`                                              |
| Ledger auditável e imutável                               | Append-only por trigger **e** por permissão (a aplicação não tem `UPDATE`/`DELETE`)                                                    |
| Nenhum evento publicado antes do commit                   | O caso de uso só grava na outbox; o relay publica depois, lendo o que já foi confirmado                                                |
| Funciona com N instâncias                                 | Nenhum estado de negócio em memória; tudo vive no PostgreSQL                                                                           |
| Uma reversão por referência                               | Índice único parcial: REFUND e ROLLBACK somados, no máximo um por transação referenciada                                               |

---

## Stack

| Componente     | Versão                                                     |
| -------------- | ---------------------------------------------------------- |
| Runtime        | Bun 1.4                                                    |
| Framework HTTP | NestJS 11                                                  |
| ORM            | MikroORM 7 (escrita explícita, sem Unit of Work implícito) |
| Banco          | PostgreSQL 16                                              |
| Fila           | Amazon SQS (FIFO); localmente, LocalStack 3.8              |
| Dinheiro       | `decimal.js`, encapsulado em `Money`                       |
| Testes         | `bun test`, contra PostgreSQL e SQS reais                  |

---

## Arquitetura em um minuto

```
                      ┌──────────────────────── instância (N réplicas) ─────────────────────────┐
 provedor ──HTTP────▶ │  api        → ProcessWagerTransactionUseCase ─┐                         │
                      │                                               │  1 transação SQL:       │
 wager-transactions ─▶│  consumer   → inbox + mesmo caso de uso ──────┼─▶ lock da wallet,       │──▶ PostgreSQL
   .fifo (SQS)        │                                               │   transação, saldo,     │    (wallets, ledger,
                      │  scheduler  → resolve PENDING_REFERENCE ──────┘   ledger, outbox        │     transações, inbox,
                      │                                                                         │     outbox)
                      │  relay      → lê a outbox (lease + SKIP LOCKED) ───────────────────────────▶ wallet-events.fifo
                      └─────────────────────────────────────────────────────────────────────────┘     (SQS)
```

- **Monólito modular hexagonal**: módulos `wallet`, `wagering` e `messaging`, cada um com `domain`, `application` (casos de uso e portas) e `infrastructure` (adaptadores). O domínio não conhece Nest nem ORM.
- **Um único caso de uso central** atende HTTP e SQS.
- **Papéis por instância** (`APP_ROLES`): a mesma imagem roda como API, consumer, relay e/ou scheduler.

---

## Pré-requisitos

| Ferramenta              | Versão                                |
| ----------------------- | ------------------------------------- |
| Bun                     | 1.4 ou superior (`bun --version`)     |
| Docker e Docker Compose | Compose v2 (`docker compose version`) |
| Git                     | qualquer versão recente               |

Portas usadas localmente: `5432` (PostgreSQL), `4566` (LocalStack), `3000` (aplicação ou balanceador), `3001`–`3003` (réplicas, no modo de 3 réplicas).

---

## Início rápido

```bash
# 1. dependências
bun install

# 2. configuração local
cp .env.example .env

# 3. PostgreSQL + LocalStack (com as 3 filas FIFO e a redrive policy)
bun run infra:up

# 4. schema
bun run migrate:up

# 5. aplicação (API + consumer + relay + scheduler, com reload)
bun run dev
```

Verifique:

```bash
curl -s localhost:3000/health/live
# {"status":"ok"}
```

### Primeira aposta

```bash
# criar a wallet
PLAYER=$(uuidgen | tr 'A-Z' 'a-z')
WALLET=$(curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

# apostar
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

Repita o mesmo comando: a resposta é idêntica, com `"idempotentReplay": true`, e o saldo não muda. Troque o `amount` mantendo a key: `409 IDEMPOTENCY_KEY_REUSED`.

---

## Rodando com 3 réplicas

O Docker Compose também sobe a aplicação como em produção: um serviço de migrations, três réplicas e um nginx na frente.

```bash
bun run stack:up      # build da imagem, migrations, app-1..3 e balanceador
docker compose ps     # migrator "Exited (0)"; app-1..3 "healthy"; lb em execução
```

| Endereço                         | Destino                            |
| -------------------------------- | ---------------------------------- |
| `localhost:3000`                 | nginx, rodízio entre as 3 réplicas |
| `localhost:3001`, `3002`, `3003` | cada réplica diretamente           |

Pare o `bun run dev` antes: ele também usa a porta 3000.

As réplicas não guardam estado em memória, então não há afinidade de sessão: qualquer réplica atende qualquer requisição, inclusive o replay de uma operação processada por outra. O nginx não reenvia `POST` para outra réplica; o reenvio é decisão do cliente, protegido pela `Idempotency-Key`.

```bash
bun run stack:down    # derruba tudo e apaga os volumes
```

---

## Configuração

O Bun carrega o `.env` automaticamente. O `.env.example` traz todos os valores padrão de desenvolvimento.

### Aplicação e banco

| Variável                 | Padrão                         | Descrição                                                                       |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------- |
| `PORT`                   | `3000`                         | Porta HTTP                                                                      |
| `APP_ROLES`              | `api,consumer,relay,scheduler` | Papéis desta instância (ver [Papéis da instância](#papéis-da-instância))        |
| `DATABASE_URL`           | —                              | Conexão de runtime, com o role `wagering_app` (sem `UPDATE`/`DELETE` no ledger) |
| `DATABASE_MIGRATION_URL` | —                              | Conexão das migrations, com o role `wagering_owner`                             |
| `MIKRO_ORM_DEBUG`        | `false`                        | `true` imprime cada query                                                       |

### SQS

| Variável                                     | Padrão                        | Descrição                                              |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `AWS_REGION`                                 | `us-east-1`                   | Região                                                 |
| `AWS_ENDPOINT_URL`                           | —                             | `http://localhost:4566` com LocalStack; ausente na AWS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test`                        | Credenciais (LocalStack aceita qualquer valor)         |
| `SQS_WAGER_QUEUE`                            | `wager-transactions.fifo`     | Entrada de transações                                  |
| `SQS_WAGER_DLQ`                              | `wager-transactions-dlq.fifo` | Dead-letter queue da entrada                           |
| `SQS_EVENTS_QUEUE`                           | `wallet-events.fifo`          | Saída de eventos                                       |
| `SQS_WAIT_TIME_SECONDS`                      | `20`                          | Long polling do consumer                               |
| `SQS_MAX_RECEIVE_COUNT`                      | `5`                           | Tentativas antes da DLQ (igual à redrive policy)       |
| `SQS_SHUTDOWN_TIMEOUT_MS`                    | `20000`                       | Tempo para terminar mensagens em andamento no SIGTERM  |

### Outbox relay

| Variável                  | Padrão  | Descrição                                                        |
| ------------------------- | ------- | ---------------------------------------------------------------- |
| `OUTBOX_BATCH_SIZE`       | `10`    | Eventos por rodada                                               |
| `OUTBOX_LEASE_MS`         | `30000` | Reserva de um lote; se o relay morrer, outro assume depois disso |
| `OUTBOX_IDLE_INTERVAL_MS` | `500`   | Espera entre rodadas quando não há pendentes                     |

### Referências fora de ordem

| Variável                            | Padrão   | Descrição                                                  |
| ----------------------------------- | -------- | ---------------------------------------------------------- |
| `PENDING_REFERENCE_BACKOFF_BASE_MS` | `1000`   | Primeira espera; dobra a cada tentativa                    |
| `PENDING_REFERENCE_BACKOFF_MAX_MS`  | `60000`  | Teto entre tentativas                                      |
| `PENDING_REFERENCE_TTL_MS`          | `900000` | Prazo (15 min) antes de rejeitar com `REFERENCE_NOT_FOUND` |
| `SCHEDULER_BATCH_SIZE`              | `20`     | Pendências por rodada                                      |
| `SCHEDULER_LEASE_MS`                | `10000`  | Reserva de cada pendência                                  |
| `SCHEDULER_IDLE_INTERVAL_MS`        | `500`    | Espera entre rodadas                                       |

### Testes

| Variável                  | Descrição                                                            |
| ------------------------- | -------------------------------------------------------------------- |
| `TEST_DATABASE_ADMIN_URL` | Owner no banco `postgres`: cria e apaga os bancos de teste           |
| `TEST_DATABASE_APP_URL`   | `wagering_app` no banco `postgres`: base das conexões dos testes     |
| `CONCURRENCY_ITERATIONS`  | Repetições de cada corrida nos testes de concorrência (padrão 10)    |
| `APP_LOGS`                | `true` mostra os logs do Nest nos testes de integração               |
| `APP_PROCESS_LOGS`        | `true` mostra os logs dos processos filhos nos testes multi-processo |

---

## API HTTP

### Endpoints

| Método e rota                                                             | Descrição                                                       | Sucesso         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------- |
| `POST /wallets`                                                           | Cria a wallet de um jogador numa moeda                          | 201             |
| `GET /wallets/:walletId`                                                  | Saldo e versão atuais                                           | 200             |
| `GET /wallets/:walletId/ledger?limit=&cursor=`                            | Lançamentos, em ordem de versão, paginados por cursor           | 200             |
| `POST /wallets/:walletId/reconciliation`                                  | Compara o saldo gravado com o saldo do ledger (somente leitura) | 200             |
| `POST /wagering/transactions`                                             | Processa uma transação (header `Idempotency-Key` obrigatório)   | 200 / 202 / 422 |
| `GET /wagering/transactions/:transactionId`                               | Consulta pelo id interno                                        | 200             |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor                                    | 200             |
| `GET /health/live`                                                        | Liveness (não consulta dependências)                            | 200             |
| `GET /health/ready`                                                       | Readiness: PostgreSQL e SQS alcançáveis                         | 200 / 503       |

Headers opcionais: `X-Correlation-Id` é propagado para os eventos gerados pela requisição.

### Criar wallet

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

Um saldo inicial maior que zero gera uma transação interna `OPENING` e o primeiro lançamento do ledger. Uma segunda wallet para o mesmo jogador e moeda responde `409 WALLET_ALREADY_EXISTS`.

### Processar transação

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

| Campo                                        | Regra                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Idempotency-Key` (header)                   | Obrigatório, até 255 caracteres. Sugestão: `<providerId>:<externalTransactionId>`        |
| `providerId`                                 | Até 64 caracteres; `system` é reservado                                                  |
| `externalTransactionId`, `roundId`, `gameId` | Até 128 caracteres                                                                       |
| `playerId`, `walletId`                       | UUID                                                                                     |
| `kind`                                       | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`                                               |
| `money.amount`                               | String decimal positiva com até 2 casas (`"25"`, `"25.5"`, `"25.00"`); nunca número JSON |
| `money.currency`                             | ISO 4217, maiúsculas (`BRL`)                                                             |
| `referenceExternalTransactionId`             | Obrigatório em REFUND e ROLLBACK; opcional em WIN; proibido em BET e LOSS                |

O corpo da resposta tem sempre o mesmo formato:

```json
{
  "transactionId": "0192f298-...",
  "status": "PROCESSED",
  "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

| `status`            | HTTP | Significado                                                                     |
| ------------------- | ---- | ------------------------------------------------------------------------------- |
| `PROCESSED`         | 200  | Aplicada (ou LOSS registrada, sem mover saldo)                                  |
| `PENDING_REFERENCE` | 202  | Aceita; a referência ainda não chegou. `balance` é `null`                       |
| `REJECTED`          | 422  | Rejeição de negócio, com `failureCode`. Reenviar igual devolve a mesma rejeição |

`balance` é o saldo **no momento da decisão**, e o replay devolve exatamente esse valor, mesmo que o saldo tenha mudado depois. Para uma pendência, reenviar a mesma requisição mostra o estado atual: 202 enquanto pendente, e o desfecho (200 ou 422) depois de resolvida.

### Erros

Erros que não são desfechos de transação usam um envelope único:

```json
{ "error": { "code": "IDEMPOTENCY_KEY_REUSED", "message": "..." } }
```

Em `VALIDATION_ERROR`, `error.details` lista os campos inválidos (`[{ "field": "...", "message": "..." }]`), todos de uma vez.

| HTTP | Códigos                                                                                                                                                                    | O que fazer                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 400  | `VALIDATION_ERROR`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `NON_POSITIVE_AMOUNT`, `OPENING_NOT_ALLOWED`, `RESERVED_PROVIDER`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED` | Corrigir o payload                                |
| 404  | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`                                                                                                                                | Conferir os ids                                   |
| 409  | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`, `DUPLICATE_TRANSACTION`                                                                                                 | Não reenviar com outro conteúdo                   |
| 503  | `TEMPORARILY_UNAVAILABLE` (com `Retry-After`)                                                                                                                              | Reenviar **a mesma** requisição; nada foi gravado |
| 500  | `INTERNAL_ERROR`                                                                                                                                                           | Investigar; reenviar a mesma requisição é seguro  |

### Ledger paginado

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

`limit` vai de 1 a 200 (padrão 50). Passe o `nextCursor` recebido para a próxima página; `null` indica o fim. O cursor é opaco e estável: lançamentos novos não deslocam as páginas já lidas.

### Reconciliação

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

Uma divergência também responde 200, com `consistent: false` e a lista de `discrepancies` (`BALANCE_MISMATCH`, `LAST_ENTRY_MISMATCH`, `VERSION_MISMATCH`, `LEDGER_CHAIN_BROKEN`, `LEDGER_VERSION_GAP`). O saldo **nunca** é corrigido. Ver [Operação](#reconciliação).

---

## Entrada pela fila SQS

Fila: `wager-transactions.fifo`. Mensagem:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "correlationId": "opcional",
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

| Atributo SQS             | Valor recomendado                                              |
| ------------------------ | -------------------------------------------------------------- |
| `MessageGroupId`         | `walletId`: mensagens da mesma wallet são processadas em ordem |
| `MessageDeduplicationId` | `messageId`                                                    |

A mensagem passa pelo **mesmo caso de uso** da API. A deduplicação da fila FIFO é só uma otimização: a garantia é a inbox persistente por `(consumer, messageId)`, gravada na mesma transação do efeito financeiro.

| Desfecho                                                                                                    | Ação                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Processada, pendente ou rejeitada por negócio                                                               | Ack (`DeleteMessage`), sempre depois do commit |
| Reentrega de mensagem já processada                                                                         | Ack, sem repetir o efeito                      |
| Mensagem inválida, wallet inexistente, conflito de idempotência, `messageId` reutilizado com outro conteúdo | DLQ imediata                                   |
| Falha transitória (lock, banco) ou erro inesperado                                                          | Retry com backoff (1 s, 2 s, 4 s... até 60 s)  |
| Retry na tentativa `SQS_MAX_RECEIVE_COUNT`                                                                  | DLQ com `RETRIES_EXHAUSTED`                    |

Mensagens na DLQ levam o corpo original e os atributos `dlq-reason`, `dlq-detail`, `original-message-id` e `receive-count`.

---

## Eventos publicados

Fila: `wallet-events.fifo`. Cada evento é gravado na outbox na mesma transação do efeito e publicado depois, pelo relay.

| Evento                             | Quando                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | Transação aplicada (inclui LOSS)                                             |
| `WagerTransactionRejected`         | Rejeição de negócio, inclusive expiração de referência                       |
| `WagerTransactionPendingReference` | Transação aguardando a referência                                            |
| `WalletBalanceChanged`             | Toda mudança de saldo, com `balanceBefore`, `balanceAfter` e `walletVersion` |

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

| Atributo SQS                | Valor                                                 |
| --------------------------- | ----------------------------------------------------- |
| `MessageGroupId`            | `aggregateId` (`walletId`)                            |
| `MessageDeduplicationId`    | `eventId`                                             |
| `eventType`, `eventVersion` | atributos de mensagem, para filtrar sem abrir o corpo |

**Para quem consome:** a entrega é **at-least-once**. Deduplique pelo `eventId`, e use `walletVersion` para ordenar e descartar eventos obsoletos da mesma wallet.

---

## Regras de negócio

### Tipos de transação

| Tipo       | Efeito no saldo               | Referência                          |
| ---------- | ----------------------------- | ----------------------------------- |
| `BET`      | Débito                        | Proibida                            |
| `WIN`      | Crédito                       | Opcional (a BET da rodada)          |
| `LOSS`     | Nenhum (registra o resultado) | Proibida                            |
| `REFUND`   | Crédito                       | Obrigatória: uma BET                |
| `ROLLBACK` | O inverso da referência       | Obrigatória: BET, WIN ou REFUND     |
| `OPENING`  | Crédito inicial               | Interno: nunca aceito de provedores |

Uma referência só pode ser revertida **uma vez**, somando REFUND e ROLLBACK. Reversões exigem o mesmo valor, a mesma rodada, wallet, jogador, moeda e provedor da referência.

### Referências fora de ordem

Se a referência ainda não existe (ou existe, mas ela própria está pendente), a transação fica `PENDING_REFERENCE`:

- nada é movimentado;
- novas tentativas com backoff (1 s, 2 s, 4 s... até 60 s);
- quando a referência chega, a pendência é antecipada imediatamente;
- após 15 minutos sem a referência, vira `REJECTED` com `REFERENCE_NOT_FOUND`.

### Códigos de rejeição (`failureCode`)

| Código                        | Quando                                                         | Ação do provedor   |
| ----------------------------- | -------------------------------------------------------------- | ------------------ |
| `INSUFFICIENT_FUNDS`          | Débito maior que o saldo                                       | Não reenviar       |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de um crédito já gasto                                | Escalar            |
| `CURRENCY_MISMATCH`           | Moeda diferente da wallet                                      | Corrigir o payload |
| `WALLET_PLAYER_MISMATCH`      | A wallet pertence a outro jogador (o saldo não é exposto)      | Corrigir o payload |
| `REFERENCE_NOT_FOUND`         | Referência não chegou dentro do prazo                          | Escalar            |
| `REFERENCE_CONTEXT_MISMATCH`  | Referência de outra rodada, wallet, jogador, moeda ou provedor | Corrigir o payload |
| `REFERENCE_INVALID_KIND`      | Tipo de referência não permitido (ex.: REFUND de WIN)          | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED`     | A referência foi rejeitada                                     | Não reenviar       |
| `REFERENCE_ALREADY_REVERSED`  | A referência já tem uma reversão                               | Não reenviar       |
| `AMOUNT_MISMATCH`             | Valor da reversão diferente da referência                      | Corrigir o payload |

---

## Papéis da instância

`APP_ROLES` define o que cada instância faz. A mesma imagem pode exercer qualquer combinação.

| Papel       | Faz                                      |
| ----------- | ---------------------------------------- |
| `api`       | Atende HTTP                              |
| `consumer`  | Consome `wager-transactions.fifo`        |
| `relay`     | Publica a outbox em `wallet-events.fifo` |
| `scheduler` | Resolve pendências de referência         |

Todos os papéis são seguros com várias instâncias ao mesmo tempo. Um valor inválido (ex.: `consumr`) derruba o boot com erro claro. No SIGTERM, cada papel termina o trabalho em andamento antes de o pool do banco fechar.

---

## Testes

Todos os testes de integração rodam contra **PostgreSQL e SQS reais** (LocalStack). Cada suíte usa um banco próprio, copiado de um template já migrado, e filas próprias, criadas e apagadas pela suíte: os testes nunca tocam o banco `wagering` nem as filas de desenvolvimento.

```bash
bun run infra:up           # obrigatório antes dos testes de integração
```

| Comando                    | O que roda                                                             | Tempo aproximado |
| -------------------------- | ---------------------------------------------------------------------- | ---------------- |
| `bun run typecheck`        | Checagem de tipos (o Bun não checa tipos ao executar)                  | segundos         |
| `bun run test:unit`        | Domínio puro, sem infraestrutura                                       | < 1 s            |
| `bun run test:integration` | Schema, persistência, HTTP, consumer, relay, pendências, reconciliação | ~30 s            |
| `bun run test:concurrency` | Corridas em 1 processo e em 3 processos separados                      | ~30 s            |
| `bun run test:resilience`  | Processos reais derrubados (SIGKILL, SIGTERM)                          | ~1 min           |

### O que as suítes provam

| Suíte         | Destaques                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema        | O banco sozinho recusa saldo negativo, ledger alterado (até pelo owner), saldo sem lançamento, reversão dupla, terceira casa decimal; migrations reversíveis                                                                                   |
| HTTP          | Cada tipo de transação, replay com o saldo da época, conflito 409, referência fora de ordem                                                                                                                                                    |
| Concorrência  | A mesma aposta 50 vezes gera um débito; 100.00 com duas apostas de 80.00 termina em uma PROCESSED e uma REJECTED; o lock é por wallet, nunca global; tudo repetido em 3 processos                                                              |
| Consumer      | Inbox na mesma transação do efeito; reentrega sem efeito duplicado; DLQ imediata para mensagens inválidas; retry com recuperação                                                                                                               |
| Relay         | 4 relays e 200 eventos sem perda nem duplicata; relay morto antes e depois de publicar                                                                                                                                                         |
| Pendências    | REFUND antes da BET e ROLLBACK antes do WIN resolvidos sozinhos; expiração; cadeias; 3 schedulers                                                                                                                                              |
| Reconciliação | Corrupções reais detectadas, registradas e **não** corrigidas; sem falsa divergência sob carga                                                                                                                                                 |
| Resiliência   | SIGKILL entre o commit e o ack; SIGTERM com mensagem em andamento; esgotamento de tentativas; relay e scheduler mortos com outra instância assumindo; **reinício total do serviço sob carga mista, com saldo final exato em todas as wallets** |

Todas as suítes que movimentam saldo terminam verificando a invariante final em todas as wallets: `wallet.balance` = soma do ledger.

### Mais repetições e depuração

```bash
CONCURRENCY_ITERATIONS=50 bun test --timeout 300000 test/concurrency   # corridas repetidas 50 vezes
MIKRO_ORM_DEBUG=true bun run test:integration                         # mostra as queries
APP_LOGS=true bun test test/integration/messaging                     # logs do Nest
APP_PROCESS_LOGS=true bun run test:resilience                         # logs dos processos filhos
```

Os testes de resiliência usam pontos de injeção de falha (`FAULT_INJECTION=crash-after-commit-before-ack`, entre outros), que só agem quando a variável está definida. Em produção a variável não existe e esses pontos não fazem nada.

---

## Operação

### Migrations

```bash
bun run migrate:status
bun run migrate:up
bun run migrate:down             # desfaz somente a última
bun run migrate:create <nome>    # migration vazia, escrita à mão
```

As migrations são escritas à mão, porque o schema usa recursos que o gerador do ORM não expressa (domínios, índices parciais, constraint triggers deferidos, GRANTs). Toda migration que criar uma tabela precisa trazer o `GRANT` correspondente para `wagering_app`.

### Reconciliação

```bash
# uma wallet
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# todas (exit 0 = consistente, 1 = divergência, 2 = falha ao executar)
bun run reconcile > divergencias.jsonl
```

O comando imprime uma linha JSON por wallet divergente e uma linha de resumo; os logs vão para o stderr. Roda bem como job agendado: o exit code 1 é o alerta.

Uma divergência é um **incidente**: o saldo não deve ser corrigido sem entender a causa. Quando for preciso corrigir, faça com um lançamento de ajuste auditável, nunca com um `UPDATE` no saldo (os triggers recusam de qualquer forma).

Métricas registradas (expostas em `/metrics` a partir da etapa de observabilidade):

| Métrica                                            | Uso                                     |
| -------------------------------------------------- | --------------------------------------- |
| `wallet_reconciliation_divergences_total{code}`    | Alerta: qualquer aumento é um incidente |
| `wallet_reconciliation_checks_total{result}`       | Volume de verificações                  |
| `wallet_reconciliation_last_run_wallets`           | Wallets verificadas na última varredura |
| `wallet_reconciliation_last_run_divergent_wallets` | Divergentes na última varredura         |

### Consultas úteis

```bash
alias psql-wagering='docker compose exec postgres psql -U wagering_owner -d wagering'

# eventos ainda não publicados e o mais antigo (lag da outbox)
psql-wagering -c "SELECT count(*), min(occurred_at) FROM outbox_messages WHERE published_at IS NULL"

# eventos com falha de publicação
psql-wagering -c "SELECT id, event_type, attempts, last_error FROM outbox_messages
                  WHERE published_at IS NULL AND attempts > 0 ORDER BY occurred_at LIMIT 20"

# pendências de referência e quando vencem
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

O atributo `dlq-reason` diz por que a mensagem está ali. Depois de corrigir a causa, reenvie o **corpo original** para a fila principal: a inbox e a idempotência garantem que uma mensagem já aplicada não seja aplicada de novo.

### Bancos de teste órfãos

Se uma execução de testes for interrompida (`Ctrl+C`), bancos `wg_test_*` podem sobrar:

```bash
docker compose exec postgres psql -U wagering_owner -d postgres -Atc \
  "SELECT 'DROP DATABASE ' || datname || ' WITH (FORCE);' FROM pg_database WHERE datname LIKE 'wg_test_%'" \
  | docker compose exec -T postgres psql -U wagering_owner -d postgres
```

---

## Estrutura do projeto

```
src/
├── main.ts                      bootstrap: lê o ambiente e monta o AppModule
├── app.module.ts                composição: papéis, persistência, mensageria, módulos
├── config/app-roles.ts          APP_ROLES
├── shared/                      Money, erros de domínio, backoff, hash canônico, portas (Clock, IdGenerator, TransactionManager)
├── modules/
│   ├── wallet/                  Wallet, ledger, criação, consultas, reconciliação
│   ├── wagering/                WagerTransaction, regras de referência, caso de uso central,
│   │                            HTTP, consumer SQS, scheduler de pendências
│   └── messaging/               inbox, outbox, relay, consumer SQS genérico, publicador
├── infrastructure/persistence/  MikroORM, transação, mapeamento de erros do Postgres, migrations
└── platform/                    HTTP (parser, filtro de erros), health, métricas, injeção de falhas

scripts/
├── migrate.ts                   up | down | status | create
├── reconcile.ts                 reconciliação de todas as wallets
└── checks/sql/                  roteiros manuais de verificação do schema

test/
├── unit/                        domínio puro
├── integration/                 schema, persistência, HTTP, mensageria, pendências, reconciliação
├── concurrency/                 1 processo e 3 processos
├── resilience/                  processos reais derrubados
└── support/                     banco por suíte, filas por suíte, processos da aplicação, clientes

docker/
├── postgres/init/01-roles.sql   role de runtime (wagering_app)
├── localstack/init-sqs.sh       filas FIFO, DLQ e redrive policy
└── nginx/nginx.conf             balanceador das 3 réplicas
```

Cada módulo segue a mesma divisão: `domain` (regras puras, sem framework), `application` (casos de uso e portas) e `infrastructure` (adaptadores: HTTP, SQS, PostgreSQL).

---

## Solução de problemas

| Sintoma                                                   | Causa                                             | Solução                                                                  |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `password authentication failed for user "wagering_app"`  | O volume do Postgres é anterior ao `01-roles.sql` | `bun run infra:down` e `bun run infra:up`                                |
| `ECONNREFUSED 127.0.0.1:5432` ou `:4566`                  | Infraestrutura fora do ar                         | `bun run infra:up`                                                       |
| LocalStack nunca fica healthy                             | O `init-sqs.sh` falhou (permissão ou CRLF)        | `chmod +x docker/localstack/init-sqs.sh`; salvar com quebra de linha LF  |
| LocalStack pede token                                     | Imagens recentes exigem conta                     | Manter a versão fixa `3.8` ou usar MiniStack                             |
| `permission denied for table ...` na aplicação            | Migration nova sem `GRANT`                        | Acrescentar o `GRANT` na migration                                       |
| `EADDRINUSE :3000`                                        | `bun run dev` e `stack:up` ao mesmo tempo         | Parar um dos dois                                                        |
| Respostas 503 sob carga numa mesma wallet                 | Espera pelo lock além de 2 s                      | Esperado: reenviar a mesma requisição; ver as limitações abaixo          |
| Logs `[query] ...` em todo lugar                          | `MIKRO_ORM_DEBUG=true` no `.env`                  | Remover a linha ou usar `false`                                          |
| `app process exited early` nos testes multi-processo      | O processo filho falhou no boot                   | `APP_PROCESS_LOGS=true` mostra o motivo                                  |
| Teste de integração falha por timeout no primeiro arquivo | Criação do template mais lenta que o timeout      | Rodar pelo script (`bun run test:integration`), que já usa timeout maior |

---

## Limitações conhecidas

- **Vazão por wallet.** O lock pessimista serializa as operações de uma mesma wallet: algumas centenas por segundo por wallet. Para um jogador é muito mais que o necessário; uma conta agregadora de volume extremo exigiria subcontas.
- **Ordem dos eventos entre relays.** Relays diferentes podem publicar eventos da mesma wallet fora de ordem. Os eventos carregam `walletVersion` para o consumidor ordenar.
- **Entrega at-least-once.** Um relay que morre entre publicar e marcar republica o evento com o mesmo `eventId`. A deduplicação do SQS FIFO (5 minutos) costuma descartar a cópia; consumidores devem deduplicar pelo `eventId` de qualquer forma.
- **Relógio das instâncias.** Leases de relay e scheduler usam o relógio de cada instância. Diferenças maiores que o lease (10 a 30 s) poderiam gerar trabalho duplicado, que é tolerado (idempotência e inbox).
- **Observabilidade ainda parcial.** As métricas já são contadas, mas ainda não expostas em `/metrics`.
- **Sem autenticação real.** A estrutura (`ProviderIdentityPort`, `ProviderAuthGuard`, `CurrentProvider`, `AuthModule`) está pronta e documentada (ADR-008 no `ARCHITECTURE.md`), mas o adapter ligado hoje (`AUTH_MODE=noop`) é fictício e nenhum controller usa o Guard ainda — o `providerId` do corpo continua não verificado contra a identidade de quem chama.
- **Ajustes de saldo.** Não existe um caso de uso de ajuste manual auditável; a reconciliação detecta divergências, e a correção é um procedimento operacional.

Detalhes, alternativas consideradas e justificativas: [ARCHITECTURE.md](ARCHITECTURE.md).
