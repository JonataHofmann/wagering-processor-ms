# ARCHITECTURE

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas de múltiplos provedores, via HTTP e SQS, com entrega at-least-once.

A correção financeira é garantida pelo **PostgreSQL**, não pelo broker nem por memória. O código de domínio decide; o banco recusa qualquer estado inconsistente que escape do código.

> Este documento cresce junto com a implementação. Decisões já implementadas estão marcadas como **Aceito**; decisões desenhadas mas ainda não implementadas, como **Proposto**.

---

## 1. Status da implementação

| Fase                        | Etapa                                                 | Status    |
| --------------------------- | ----------------------------------------------------- | --------- |
| Fundação                    | 1. Repositório (Bun + NestJS + TypeScript estrito)    | Concluída |
|                             | 2. Infraestrutura local (PostgreSQL + LocalStack SQS) | Concluída |
|                             | 3. MikroORM e runner de migrations                    | Concluída |
|                             | 4. Schema, constraints, triggers, permissões e testes | Concluída |
| Domínio puro                | 5. `Money`                                            | Concluída |
|                             | 6. `Wallet` e `WalletLedgerEntry`                     | Concluída |
|                             | 7. `WagerTransaction`                                 | Pendente  |
|                             | 8. `InboxMessage` e `OutboxMessage`                   | Pendente  |
| Persistência e casos de uso | 9 a 12                                                | Pendente  |
| Instâncias e mensageria     | 13 a 16                                               | Pendente  |
| Garantias finais            | 17 a 20                                               | Pendente  |
| Entrega                     | 21 a 23                                               | Pendente  |

---

## 2. Stack

| Item                                  | Escolha                    | Observação                                                                                       |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| Runtime, package manager, test runner | Bun 1.x                    | O Bun executa TypeScript mas não checa tipos: `bun run typecheck` (`tsc --noEmit`) é obrigatório |
| Linguagem                             | TypeScript em modo estrito | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`                                       |
| Framework                             | NestJS                     | Usado só nas bordas (HTTP, DI, ciclo de vida). O domínio não depende dele                        |
| Banco                                 | PostgreSQL 16              |                                                                                                  |
| ORM                                   | MikroORM 7.2.5             | API do migrator: `orm.migrator`, `getExecuted()`, `getPending()`, `create()`                     |
| Mensageria                            | AWS SQS via LocalStack 3.8 | Versão fixa; versões recentes da imagem exigem token                                             |
| Dinheiro                              | `decimal.js`               | Encapsulado em `Money`; nunca exposto                                                            |
| Orquestração local                    | Docker Compose             |                                                                                                  |

---

## 3. Visão geral da arquitetura

```
Provedores ──HTTP──▶ ┌──────────────────────────────────────────────┐
                     │  App NestJS (mesma imagem, N réplicas)       │
SQS ──────────────▶  │  papéis via APP_ROLES:                       │
                     │  api · consumer · relay · scheduler          │
                     │                                              │
                     │  Application (casos de uso)                  │
                     │  Domain (puro: Money, Wallet, Transaction)   │
                     │  Infrastructure (MikroORM, SQS)              │
                     └───────────────┬──────────────────────────────┘
                                     ▼
                     PostgreSQL: wallets · wager_transactions ·
                     wallet_ledger_entries · inbox · outbox
```

- **Monólito modular** com N réplicas stateless (ADR-001).
- **Arquitetura hexagonal**: domínio puro, casos de uso com portas, adaptadores na infraestrutura (ADR-002).
- **Um único banco transacional**: saldo, ledger, transação, inbox e outbox mudam na mesma transação SQL.

---

## 4. Decisões arquiteturais

### ADR-001 — Monólito modular com N réplicas stateless

**Status:** VALIDAR

**Contexto.** Saldo, ledger, transação, inbox e outbox precisam mudar atomicamente. O domínio tem um único bounded context transacional: a wallet.

**Decisão.** Uma única imagem NestJS, em módulos (`wallet`, `wagering`, `messaging`, `shared`, `platform`). Cada réplica assume papéis via a variável `APP_ROLES` (`api`, `consumer`, `relay`, `scheduler`). Toda coordenação entre réplicas acontece no PostgreSQL.

**Alternativa descartada.** Microsserviços separados para wallet e wagering exigiriam saga ou 2PC dentro de uma movimentação de saldo.

**Consequências.** Atomicidade com uma transação local. Escala horizontal para wallets distintas; o limite passa a ser o PostgreSQL primário. Em produção, os papéis podem rodar em deployments separados sem mudança de código.

### ADR-002 — Arquitetura hexagonal com domínio puro

**Status:** Aceito (estrutura);

**Decisão.**

- Camadas por módulo: `domain` (sem imports de NestJS ou ORM), `application` (casos de uso e portas), `infrastructure` (adaptadores).
- Construtores privados e factories estáticas (`from`, `create`, `open`, `rehydrate`). `rehydrate` reconstrói estado persistido sem revalidar transições.
- Erros de regra de negócio herdam de `DomainError`, com `code` estável e legível por máquina.

**Consequências.** O domínio é testado em milissegundos, sem banco. O custo é código de mapeamento entre domínio e persistência.

### ADR-003 — MikroORM 7 com migrations escritas à mão

**Status:** Aceito

**Contexto.** O schema usa recursos que o gerador de migrations do ORM não expressa: domains com CHECK, índices únicos parciais, constraint triggers deferidos, GRANTs.

**Decisão.**

- Migrations escritas à mão (`snapshot: false`), uma por responsabilidade, todas com `up()` e `down()`.
- `transactional: true` e `allOrNothing: true`: um lote de migrations aplica por inteiro ou não aplica.
- `disableForeignKeys: false`: o modo padrão de desligar FKs no Postgres (`session_replication_role = replica`) também desligaria os triggers de integridade.
- Runner programático (`scripts/migrate.ts`) em vez do CLI do Mikro, por compatibilidade com o Bun.
- Regras de escrita: um statement por `addSql`, nenhum `?` no SQL.

**Consequências.** Toda tabela nova exige migration manual e o GRANT correspondente.

### ADR-004 — Representação monetária exata

**Status:** Aceito

**Decisão.**

- `Money` imutável (`Object.freeze`), encapsulando um construtor `Decimal` isolado (`Decimal.clone`), sem alterar a configuração global do `decimal.js`.
- A entrada é validada por regex **antes** de chegar ao `decimal.js`, que aceitaria `1e3`, `NaN` e `Infinity`.
- Saída sempre com 2 casas (`"25.00"`). Somas e subtrações de valores com 2 casas são exatas; nada arredonda. `ROUND_HALF_EVEN` fica configurado para eventual uso futuro de divisão.
- No banco: domain `money_amount` (`numeric` sem escala com `CHECK (scale(VALUE) <= 2)`) e `currency_code` (`char(3)` maiúsculo).
- Contratos e eventos carregam `MoneyProps` (`{ amount: string, currency: string }`), nunca a instância.

**Alternativas descartadas.**

- `numeric(20,2)` arredonda silenciosamente `10.005` para `10.01`, escondendo bugs de parser.
- Inteiro em centavos acopla a escala à moeda e exige conversão em cada borda.

**Interpretações adotadas.**

- Entrada com 0 ou 1 casa (`"25"`, `"25.5"`) é aceita e normalizada para 2 casas. O enunciado proíbe mais de 2 casas; menos não é ambíguo. A forma canônica é a única que circula internamente e entra no `payloadHash`.
- Formatos ambíguos são rejeitados: sinal explícito, `.5`, `5.`, zeros à esquerda, vírgula, espaços. Limite de 18 dígitos inteiros, igual ao domain do banco.
- Negativos são proibidos na entrada (`Money.from`) e permitidos como resultado interno de `subtract` e `negate`, para o domínio expressar "o saldo ficaria negativo?".
- `equals` entre moedas diferentes devolve `false`; `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError`.
- Moedas com 0 ou 3 casas decimais (JPY, KWD) exigiriam escala por moeda. Fora de escopo.

### ADR-005 — Invariantes financeiras garantidas no schema

**Status:** Aceito

**Contexto.** O enunciado exige unicidade, imutabilidade e não-negatividade no banco, não apenas no código. Código tem bugs; com várias instâncias, unicidade só o banco garante.

**Decisão.** O código governa, o banco garante:

| Camada  | Papel                                                    | Quando age              |
| ------- | -------------------------------------------------------- | ----------------------- |
| Domínio | Decide e produz (saldo, lançamento, status, failureCode) | Sempre                  |
| Banco   | Verifica e recusa                                        | Só quando o código erra |

Os triggers **nunca escrevem dados**. Um erro `WL00x` em produção indica bug, não regra de negócio.

Detalhes na seção 5.

**Interpretação adotada.** Uma referência só pode ser revertida **uma vez no total**, por REFUND ou ROLLBACK. A leitura literal ("uma vez por tipo de operação") permitiria REFUND seguido de ROLLBACK da mesma BET, creditando o valor duas vezes e violando a invariante global de não duplicar créditos.

**Consequências.** Custo de alguns lookups por índice único a cada escrita financeira. Erros `WL002` surgem no COMMIT, então o tratamento de erro precisa envolver o commit.

### ADR-006 — Dois roles no banco (menor privilégio)

**Status:** REVISAR

**Contexto.** O `POSTGRES_USER` da imagem é superusuário e ignora GRANTs.

**Decisão.**

- `wagering_owner`: dono do schema; usado só pelas migrations (`DATABASE_MIGRATION_URL`).
- `wagering_app`: único role usado em runtime (`DATABASE_URL`), criado por `docker/postgres/init/01-roles.sql` sem privilégios; recebe só o necessário na migration 4.
- O role é criado no init do container (é do cluster, não do banco); as permissões por tabela ficam na migration (dependem das tabelas).
- Sem `ALTER DEFAULT PRIVILEGES`: cada tabela nova recebe GRANT explícito.

**Consequências.** O ledger fica protegido por duas camadas independentes: permissão (`42501`) e trigger (`WL001`).

### ADR-009 — Camada de aplicação e contrato HTTP de erros

**Status:** Aceito (wallets); estendido na etapa 11 (transações)

**Decisão.**

- Casos de uso são classes puras, montadas pelos módulos Nest via `useFactory`
  e injetadas pelos tokens das portas.
- `PersistenceModule` global compõe ORM, transação, relógio, ids e repositórios.
  `AppModule.register({ databaseUrl })` recebe a configuração por parâmetro.
- `@mikro-orm/nestjs` não é usado: o `MikroORM` vem de um provider próprio,
  fechado no shutdown (`OnApplicationShutdown`).
- Validação de entrada com `RequestParser`, que reúne todas as violações;
  o formato do dinheiro continua sendo responsabilidade do `Money`.
- Um filtro global traduz qualquer erro, de forma consistente em todos os endpoints:

| Situação            | Status              | `error.code`                                              |
| ------------------- | ------------------- | --------------------------------------------------------- |
| Entrada inválida    | 400                 | `VALIDATION_ERROR` (com `details`), `INVALID_AMOUNT`, ... |
| Recurso inexistente | 404                 | `WALLET_NOT_FOUND`                                        |
| Conflito            | 409                 | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`         |
| Regra de negócio    | 422                 | o `failureCode`                                           |
| Falha transitória   | 503 + `Retry-After` | `TEMPORARILY_UNAVAILABLE`                                 |
| Bug                 | 500                 | `INTERNAL_ERROR`, sem detalhes                            |

- Ledger paginado por cursor opaco (`base64url` de `{"v": walletVersion}`),
  buscando `limit + 1` para saber se há próxima página.

**Consequências.** A etapa 11 só acrescenta códigos à tabela do filtro.

### ADR-010 — Concorrência: lock pessimista por wallet

**Status:** Aceito

**Decisão.** `SELECT ... FOR UPDATE` na wallet no início da transação, em `READ COMMITTED`,
com `lock_timeout` de 2 s. Todas as leituras da decisão (idempotência, referência,
reversão já feita, saldo) acontecem com a wallet travada. `UPDATE ... WHERE version = ?`
permanece como defesa em profundidade.

**Por que não otimista.** A contenção na mesma wallet é o caso normal (reenvios do provedor,
BET e WIN da mesma rodada, 50 requisições idênticas). O otimista geraria tempestades de retry,
exigiria um limite de tentativas que vira erro sob carga legítima, e a `version` (que só muda
com o saldo) não protegeria decisões sem movimento, como rejeições e PENDING_REFERENCE.

**Por que é seguro.** Uma wallet por transação: sem deadlock. Transação curta e sem I/O de rede.
Lock por linha, nunca global: wallets diferentes rodam em paralelo.

**Limite.** Serializa cada wallet: algumas centenas de operações por segundo por wallet.

### ADR-011 — Idempotência

**Status:** Aceito

**Decisão.**

1. Fast path sem lock: key existente → replay (mesmo hash) ou 409 (hash diferente).
2. Sob o lock: re-checagem da key (quem esperou o lock pode ter perdido a corrida).
3. Corrida entre wallets diferentes com a mesma key: a `UNIQUE (idempotency_key)` decide;
   o perdedor relê e responde replay ou 409.
4. Toda decisão é persistida, inclusive REJECTED e PENDING_REFERENCE, com o saldo observado:
   o replay devolve a resposta original, com o saldo da época.

**payloadHash.** SHA-256 (hex) de JSON canônico RFC 8785 sobre: providerId,
externalTransactionId, playerId, walletId, roundId, gameId, kind, money (amount com 2 casas,
currency) e referenceExternalTransactionId (vazio = ausente). Fora: o header
Idempotency-Key, correlationId, messageId e qualquer metadado de transporte.

**Interpretações.**

- WALLET_NOT_FOUND responde 404 e não é persistido (não há wallet para a FK nem para o lock).
- WALLET_PLAYER_MISMATCH é persistido, mas a resposta não traz o saldo da wallet alheia.
- O mesmo (providerId, externalTransactionId) com outra key responde 409 DUPLICATE_TRANSACTION.

## 6. Domínio e componentes compartilhados

### 6.1 Erros do domínio

| Tipo                      | Exemplos                                                    | Significado                  | Tratamento                                     |
| ------------------------- | ----------------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| `DomainError`             | `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `INVALID_AMOUNT` | Situação de negócio prevista | Transação REJECTED com `failureCode`, HTTP 422 |
| `InvariantViolationError` | Lançamento desbalanceado, movimento de valor zero           | Bug                          | Erro interno e alarme; nunca vira rejeição     |

`InvariantViolationError` estende `Error`, não `DomainError`: um tratamento do tipo
`if (error instanceof DomainError) rejeitar()` nunca transforma um bug em rejeição de negócio.

### 6.2 `Money`

| Método                                                       | Comportamento                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `Money.from(props)`                                          | Valida e normaliza; lança `InvalidMoneyError` (`INVALID_AMOUNT` / `INVALID_CURRENCY`) |
| `Money.zero(currency)`                                       | Zero na moeda                                                                         |
| `add`, `subtract`                                            | Exatos; lançam `CurrencyMismatchError` entre moedas diferentes                        |
| `negate`                                                     | Inverte o sinal; `-0` é normalizado para `0.00`                                       |
| `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals` | Consultas                                                                             |
| `amount`                                                     | String com 2 casas, usada na persistência                                             |
| `toJSON()`                                                   | `MoneyProps`                                                                          |
| `toString()`                                                 | `"25.00 BRL"`, para logs                                                              |

Decisões e interpretações: ADR-004.

### 6.3 Portas compartilhadas

| Porta                | Implementação                          | Fake de teste                   |
| -------------------- | -------------------------------------- | ------------------------------- |
| `Clock`              | `SystemClock`                          | `FixedClock` (tempo controlado) |
| `IdGenerator`        | `UuidV7Generator` (`Bun.randomUUIDv7`) | `SequentialIdGenerator`         |
| `TransactionManager` | etapa 9 (MikroORM)                     | —                               |

Cada porta exporta um token `Symbol` para injeção no Nest, sem importar o Nest.
O domínio nunca gera ids nem lê o relógio: recebe ambos da camada de aplicação.

### 6.4 Hash canônico

`payloadHash = SHA-256(JCS(payload))`, em hex minúsculo de 64 caracteres (RFC 8785).

- Chaves ordenadas por unidade UTF-16; sem espaços; propriedades `undefined` omitidas.
- Rejeita o que não é JSON puro (`NaN`, `Infinity`, `Date`, `Money`, classes):
  a conversão para JSON é explícita, para o hash nunca depender de um `toJSON` implícito.
- Os campos que entram no hash são definidos pelo caso de uso (etapa 11).

### 6.5 UUIDv7

Ids ordenáveis pelo tempo: inserções sempre no fim dos índices B-tree,
sem colisão entre instâncias.

### 6.6 `Wallet` (aggregate root) e `WalletLedgerEntry`

- `debit` e `credit` devolvem o `WalletLedgerEntry` correspondente: não existe caminho
  que mude o saldo sem produzir o lançamento.
- `Wallet.open` devolve a wallet (versão 1) e, se o saldo inicial for > 0, o lançamento
  OPENING (CREDIT v1, 0 → saldo inicial). Adaptação da assinatura do enunciado.
- O lançamento é criado antes de alterar a wallet: uma operação que falha não deixa rastro.
- `version` começa em 1 e sobe 1 a cada movimento; operações recusadas não a alteram.
- `canDebit` permite consultar se um débito cabe no saldo sem lançar exceção.
- `WalletLedgerEntry` é estruturalmente imutável (sem métodos de mutação, `Object.freeze`).
  `create` valida aritmética, moedas, valor positivo, saldos não negativos e versão;
  `rehydrate` não valida, e `isBalanced()` permite detectar inconsistências na leitura.
- `signedMoney()` devolve o valor com sinal; a soma de todos os lançamentos reconstrói o saldo.
- `walletVersion` foi acrescentado ao lançamento, espelhando `uq_ledger_wallet_version`.

A wallet não distingue débito de aposta e de reversão: o caso de uso traduz
`INSUFFICIENT_FUNDS` para `REVERSAL_INSUFFICIENT_FUNDS` quando o débito vem de um ROLLBACK.

### 6.7 `WagerTransaction`

| De                          | Ação                                | Para                                 |
| --------------------------- | ----------------------------------- | ------------------------------------ |
| PENDING                     | `markProcessed` / `reject` / `fail` | PROCESSED / REJECTED / FAILED        |
| PENDING                     | `markPendingReference`              | PENDING_REFERENCE                    |
| PENDING_REFERENCE           | `rescheduleReferenceLookup`         | PENDING_REFERENCE (`attempts` + 1)   |
| PENDING_REFERENCE           | `markProcessed` / `reject` / `fail` | PROCESSED / REJECTED / FAILED        |
| PROCESSED, REJECTED, FAILED | qualquer                            | `InvalidTransactionStateError` (bug) |

- `create` valida o payload: OPENING e o provider `system` são reservados; REFUND/ROLLBACK
  exigem referência; BET/LOSS não aceitam; valor zero é recusado. Esses erros são
  `InvalidWagerTransactionError` (HTTP 400) e não são persistidos.
- `createOpening` é o único caminho para criar OPENING (caso de uso de criar wallet).
- `markProcessed` e `reject` recebem o saldo observado (`balanceSnapshot`), devolvido no replay.
- `reject` só aceita códigos de rejeição; `fail`, só códigos de falha.
- `ledgerDirectionFor`: BET debita; OPENING, WIN e REFUND creditam; ROLLBACK inverte a referência;
  LOSS não tem direção.
- `insufficientFundsFailureCode()`: `REVERSAL_INSUFFICIENT_FUNDS` para ROLLBACK,
  `INSUFFICIENT_FUNDS` para o resto.

### 6.8 Política de referência

| Transação | Pode referenciar |
| --------- | ---------------- |
| WIN       | BET (opcional)   |
| REFUND    | BET              |
| ROLLBACK  | BET, WIN, REFUND |

Ordem de avaliação: tipo → contexto (provider, player, wallet, moeda, rodada) →
referência PROCESSED → valor igual (só reversões) → ainda não revertida (só reversões).
A política devolve o `FailureCode`, sem lançar; o fato "já revertida" é consultado pelo caso de uso.

### 6.9 `FailureCode`

| Código                        | Status           | Ação do provedor |
| ----------------------------- | ---------------- | ---------------- |
| `INSUFFICIENT_FUNDS`          | REJECTED         | Desistir         |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED         | Escalar          |
| `CURRENCY_MISMATCH`           | REJECTED         | Corrigir payload |
| `WALLET_NOT_FOUND`            | (não persistido) | Corrigir payload |
| `WALLET_PLAYER_MISMATCH`      | REJECTED         | Corrigir payload |
| `REFERENCE_NOT_FOUND`         | REJECTED         | Escalar          |
| `REFERENCE_CONTEXT_MISMATCH`  | REJECTED         | Corrigir payload |
| `REFERENCE_INVALID_KIND`      | REJECTED         | Corrigir payload |
| `REFERENCE_NOT_PROCESSED`     | REJECTED         | Desistir         |
| `REFERENCE_ALREADY_REVERSED`  | REJECTED         | Desistir         |
| `AMOUNT_MISMATCH`             | REJECTED         | Corrigir payload |
| `INFRA_RETRIES_EXHAUSTED`     | FAILED           | Reenviar depois  |

### 6.10 Eventos de integração

| Evento                             | Quando                                      | Módulo   |
| ---------------------------------- | ------------------------------------------- | -------- |
| `WagerTransactionProcessed`        | Qualquer transação aplicada, inclusive LOSS | wagering |
| `WagerTransactionRejected`         | Rejeição de negócio                         | wagering |
| `WagerTransactionPendingReference` | Referência ausente                          | wagering |
| `WalletBalanceChanged`             | Somente quando o saldo muda                 | wallet   |

- `aggregateId` é sempre o `walletId` (vira `MessageGroupId` no SQS FIFO).
- `eventType` e `version` ficam no tipo de cada subclasse.
- `data` é só JSON puro: `MoneyProps`, datas em ISO-8601, `null` em vez de `undefined`.
- Cada `from` confere o estado: não há evento de transação pendente marcada como processada.

### 6.11 Backoff exponencial

`delay = min(teto, base × 2^(tentativa − 1))`, com **equal jitter**
(espera sorteada entre a metade e o valor exponencial).

- Equal jitter espalha os retries de várias instâncias sem nunca esperar zero.
- A fonte de aleatoriedade é injetável; testes usam `jitter: 'none'`.
- Reaproveitado na outbox (aqui), no consumer SQS (etapa 14) e nas pendências de referência (etapa 16).

### 6.12 `InboxMessage` e `OutboxMessage`

|                            | Inbox                                            | Outbox                                                     |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Papel                      | Registro de mensagem recebida já processada      | Evento à espera de publicação                              |
| Criação                    | `receive` (valida ids e hash)                    | `enqueue(evento)` (payload = envelope do evento)           |
| Estado                     | `processedAt`                                    | `attempts`, `nextAttemptAt`, `publishedAt`, `lastError`    |
| Duplicata entre instâncias | PK `(consumer_name, message_id)` + `ON CONFLICT` | `UPDATE ... WHERE published_at IS NULL` + lease (etapa 15) |

**Outbox sem limite de tentativas.** O enunciado proíbe perder eventos confirmados.
O limite é sobre o intervalo (teto de 5 min), não sobre o número de tentativas.
Evento que não sai fica visível pela métrica de lag e por `attempts`.

- Evento recém-enfileirado já está vencido (`nextAttemptAt = occurredAt`).
- O backoff conta a partir do momento da falha, não da data do evento.
- `markPublished` e `markProcessed` repetidos são bug; a duplicata real entre
  instâncias é resolvida no banco.
- O lease dos relays (`locked_until`, `locked_by`) fica fora do domínio: é mecanismo
  de coordenação em SQL.

### 6.13 `CreateWallet`

Em uma única transação: wallet (v1) + transação OPENING (PROCESSED) + lançamento CREDIT

- eventos `WagerTransactionProcessed` e `WalletBalanceChanged`.
  Saldo inicial zero: só a wallet, sem OPENING, lançamento ou evento.
  Duplicata de jogador + moeda: a `UNIQUE` do banco decide, mesmo sob concorrência (409).

### 6.14 `ProcessWagerTransaction`

Ordem da decisão, sob o lock: dono da wallet → moeda → referência (ausente: PENDING_REFERENCE;
inválida: código da política) → LOSS (processa sem movimento) → saldo (débito sem saldo:
INSUFFICIENT_FUNDS ou REVERSAL_INSUFFICIENT_FUNDS) → movimento.

| Resultado | HTTP | Eventos |
|---|---|---|
| PROCESSED com movimento | 200 | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| PROCESSED (LOSS) | 200 | `WagerTransactionProcessed` |
| REJECTED | 422 | `WagerTransactionRejected` |
| PENDING_REFERENCE | 202 | `WagerTransactionPendingReference` |

O mesmo caso de uso atende HTTP e SQS (`causationId` = messageId).