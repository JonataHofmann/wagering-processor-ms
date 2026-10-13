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

### ADR-007 — Estratégia de testes: infraestrutura real, banco isolado e concorrência verificada

**Status:** Aceito (camadas unitária, schema, persistência, HTTP e concorrência em um processo);
estendido nas etapas 13 a 18 (múltiplas instâncias, falhas e reinício)

**Contexto.**
O enunciado elimina soluções cujos testes substituem completamente PostgreSQL e SQS por mocks,
exige testes de concorrência com paralelismo real (não mocks sequenciais) e define como
invariante final de todos os testes: `wallet.balance == saldo reconstruído pelo ledger`.
As garantias mais importantes do sistema (unicidade, imutabilidade, não-negatividade,
serialização por wallet) vivem no banco; só um banco real consegue prová-las.

**Decisão.**

1. **Pirâmide em camadas, cada uma provando o que só ela pode provar.**

| Camada       | Pasta                          | Infraestrutura                   | Prova                                                                                                             |
| ------------ | ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Unitária     | `test/unit`                    | Nenhuma                          | Regras do domínio: `Money`, `Wallet`, `WagerTransaction`, política de referência, backoff, hash canônico, eventos |
| Schema       | `test/integration/schema`      | PostgreSQL                       | O banco sozinho recusa estados inválidos: constraints, triggers, permissões, migrations reversíveis               |
| Persistência | `test/integration/persistence` | PostgreSQL                       | Ida e volta domínio ↔ banco, transação, lock, atomicidade entre repositórios                                      |
| HTTP         | `test/integration/http`        | PostgreSQL + aplicação Nest real | Contrato da API, status HTTP, idempotência, regras de negócio de ponta a ponta                                    |
| Concorrência | `test/concurrency`             | PostgreSQL + aplicação Nest real | Corridas reais: serialização por wallet, idempotência sob disputa, lock timeout                                   |

2. **Infraestrutura real, nunca simulada.**
   - Testes de integração e concorrência rodam contra o PostgreSQL do Docker Compose
     (e contra o LocalStack a partir da etapa 14).
   - Os testes HTTP sobem a aplicação Nest completa (`AppModule.register`) numa porta livre
     (`listen(0)`) e falam com ela por `fetch`: filtro de erros, controller, caso de uso,
     repositórios, MikroORM, PostgreSQL e triggers, sem nada substituído.
   - O domínio é testado sem infraestrutura porque é puro (ADR-002), não porque algo foi mockado.

3. **Um banco isolado por suíte, copiado de um template.**
   - `test/support/database.ts` migra `wagering_test_template` uma única vez por execução de
     `bun test` e cria cada banco de suíte com `CREATE DATABASE wg_test_<uuid> TEMPLATE ...`
     (milissegundos, com tabelas, triggers, domains e permissões).
   - Cada banco é apagado no `afterAll` (`DROP DATABASE ... WITH (FORCE)`).
   - Os testes nunca tocam o banco `wagering` de desenvolvimento.

4. **Testes conectam como a aplicação.**
   - O MikroORM dos testes usa `wagering_app` (`TEST_DATABASE_APP_URL`), com exatamente as
     permissões de produção. O owner só é usado onde o teste precisa provar que até ele é
     barrado pelos triggers.

5. **Asserções por código, não por texto.**
   - Erros do banco são comparados pelo SQLSTATE (`23505`, `23514`, `23503`, `42501`,
     `WL001`–`WL004`) via `sqlState()`, nunca pela mensagem, que muda com versão e idioma.
   - Erros da API são comparados por status HTTP e `error.code`.

6. **Cada teste de constraint viola uma única regra.**
   O PostgreSQL verifica em ordem fixa (CHECK → UNIQUE → FOREIGN KEY → triggers deferidos
   no COMMIT) e para na primeira falha. Um dado que viola duas regras faz o teste depender
   dessa ordem e não provar o que diz provar.

7. **Concorrência com paralelismo real e repetição.**
   - Requisições HTTP simultâneas (`Promise.all`), cada uma com sua conexão do pool e sua
     transação no PostgreSQL.
   - Cada corrida é repetida `CONCURRENCY_ITERATIONS` vezes (padrão 10; verificado com 50),
     porque uma corrida que passa uma vez pode ter tido sorte.
   - Asserções sobre o banco (contagem de lançamentos por direção), não só sobre as respostas:
     um débito duplicado aparece no ledger mesmo que a resposta pareça certa.
   - Locks segurados por fora da aplicação (`connectPersistence` sobre o mesmo banco) para
     provar comportamento sob espera: lock por wallet e `lock_timeout`.

8. **Invariante final em todas as suítes que movimentam saldo.**
   `walletsInconsistentWithLedger()` (`test/support/invariants.ts`) compara, numa única query,
   o saldo de cada wallet com a soma assinada do seu ledger. O `afterAll` exige lista vazia.

9. **Determinismo.**
   - `Clock` e `IdGenerator` injetáveis; nos testes de domínio e persistência, `FixedClock`
     e `SequentialIdGenerator` tornam datas e ids previsíveis.
   - O backoff aceita `jitter: 'none'` ou uma fonte aleatória injetada.
   - Cada teste cria os próprios dados (wallets e jogadores com UUID novo), sem depender
     da ordem de execução.

10. **Todo teste importante passa por um "experimento de sabotagem".**
    Ao escrever um teste de garantia, a regra correspondente é desligada de propósito
    (trigger comentado, lock removido, `.sort()` retirado do hash, re-checagem de
    idempotência comentada) para confirmar que o teste falha. Um teste que nunca falha
    não prova nada.

**Helpers de teste.**

| Helper                            | Papel                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `test/support/database.ts`        | Template, banco isolado por suíte, `runMigrations`                                               |
| `test/support/pg.ts`              | `inTx`, `sqlState`, `queryOnce`                                                                  |
| `test/support/schema-fixtures.ts` | Dados válidos direto no banco para os testes de schema                                           |
| `test/support/persistence.ts`     | `createPersistence` (banco próprio) e `connectPersistence` (banco compartilhado com a aplicação) |
| `test/support/http-app.ts`        | Sobe a aplicação real contra um banco isolado                                                    |
| `test/support/wagering-client.ts` | Cliente da API reutilizado por HTTP e concorrência                                               |
| `test/support/invariants.ts`      | Invariante saldo = ledger para todas as wallets                                                  |
| `test/support/fakes.ts`           | `FixedClock`, `SequentialIdGenerator`                                                            |
| `scripts/checks/sql/*.sql`        | Roteiros manuais de verificação do schema (depuração e apresentação)                             |
| `bun run test:resilience`         | Falhas com processos reais (lento: espera timeouts)                                              |

**Matriz de concorrência (etapa 12).**

| Cenário                            | O que prova                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| 100.00 com duas apostas de 80.00   | Uma PROCESSED, uma REJECTED, saldo 20.00, um débito          |
| 30 apostas de 10.00 sobre 100.00   | 10 aceitas e saldos observados únicos: decisões serializadas |
| BET, WIN e LOSS simultâneos        | Saldo final = soma exata das operações aceitas               |
| A mesma aposta 50 vezes            | Um débito, 49 replays, um único `transactionId`              |
| A mesma key em wallets diferentes  | A `UNIQUE` decide; as perdedoras recebem 409                 |
| REFUNDs simultâneos da mesma BET   | Só um devolve; os demais `REFERENCE_ALREADY_REVERSED`        |
| Criação simultânea da mesma wallet | Uma 201, as demais 409                                       |
| 20 wallets em paralelo             | Cada uma fecha certo, independentemente                      |
| Wallet A travada, aposta em B      | B responde na hora: o lock é por wallet, nunca global        |
| Espera além do `lock_timeout`      | 503 + `Retry-After`, nada gravado, o reenvio processa        |

**Cobertura dos testes obrigatórios do enunciado.**

| Exigido                                                                        | Situação                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------- |
| Operações e validações de `Money` (escala, arredondamento, entradas inválidas) | Coberto (unitário)                             |
| Invariantes da `Wallet`                                                        | Coberto (unitário)                             |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK                                     | Coberto (unitário e HTTP)                      |
| Conflito de moeda                                                              | Coberto (unitário e HTTP)                      |
| Idempotency key com payload divergente                                         | Coberto (unitário e HTTP)                      |
| Migrations e constraints                                                       | Coberto (schema)                               |
| Atomicidade entre wallet, ledger, inbox e outbox                               | Coberto (persistência e HTTP)                  |
| A mesma aposta 50 vezes em paralelo                                            | Coberto (concorrência)                         |
| Disputa pelo saldo da mesma wallet                                             | Coberto (concorrência)                         |
| Wallets distintas em paralelo                                                  | Coberto (concorrência)                         |
| ≥ 3 processos ou instâncias                                                    | Etapa 13                                       |
| Inbox, redelivery, retry e DLQ                                                 | Etapa 14                                       |
| Worker morto depois do commit e antes do ack                                   | Etapa 14                                       |
| Publishers concorrentes sobre a mesma outbox                                   | Etapa 15                                       |
| ROLLBACK ou REFUND antes da referência (processamento posterior)               | Etapa 16                                       |
| Reinício do serviço com consistência final                                     | Etapa 18                                       |
| Inbox, redelivery, retry e DLQ                                                 | Coberto (handler, ponta a ponta e resiliência) |
| Worker morto depois do commit e antes do ack                                   | Coberto (resiliência, SIGKILL real)            |
| **Comandos.**                                                                  |

| Comando                                                                | Roda                         |
| ---------------------------------------------------------------------- | ---------------------------- |
| `bun run test:unit`                                                    | Domínio, sem infraestrutura  |
| `bun run test:integration`                                             | Schema, persistência e HTTP  |
| `bun run test:concurrency`                                             | Corridas em um processo      |
| `CONCURRENCY_ITERATIONS=50 bun test --timeout 300000 test/concurrency` | Corridas com mais repetições |
| `MIKRO_ORM_DEBUG=true bun run test:concurrency`                        | Idem, mostrando as queries   |

**Alternativas descartadas.**

- **Mocks de banco ou de repositório nos testes de integração:** proibido pelo enunciado e
  incapaz de provar constraints, triggers, locks e atomicidade.
- **`TRUNCATE` entre testes:** impossível por design, porque o ledger bloqueia TRUNCATE.
- **Uma transação desfeita por teste:** não serve para concorrência (várias conexões) nem
  para triggers deferidos (só disparam no COMMIT).
- **Testcontainers por suíte:** isolamento máximo, mas boot lento por suíte e suporte
  incerto no Bun. O template no mesmo PostgreSQL dá isolamento equivalente em milissegundos.

**Consequências.**

- A suíte de integração e concorrência exige Docker em execução e leva segundos, não
  milissegundos.
- Em troca, cada garantia avaliada pelo enunciado tem um teste que falharia se ela quebrasse,
  executado contra a mesma infraestrutura que a produção usaria.
- Um banco esquecido por um teste interrompido (`Ctrl+C`) pode sobrar; a limpeza manual está
  documentada no README.

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

### ADR-012 — Múltiplas instâncias sem estado em memória

**Status:** Aceito

**Decisão.**

- A aplicação não guarda estado de negócio em memória: idempotência, lock e saldo vivem no
  PostgreSQL. Qualquer réplica atende qualquer requisição, inclusive o replay de uma
  operação processada por outra.
- Imagem Docker em dois estágios (dependências de produção + runtime), Bun em versão fixa,
  usuário sem privilégios.
- Docker Compose: `migrator` aplica as migrations uma vez e encerra; três réplicas
  (`app-1`..`app-3`) só sobem depois dele; nginx faz rodízio simples, sem afinidade de sessão.
- O nginx não reenvia POST para outra réplica: o reenvio é decisão do cliente,
  protegido pela Idempotency-Key.

**Verificação.** `test/concurrency/multi-instance.test.ts` sobe três processos
`bun src/main.ts` separados (cada um com seu pool), sobre o mesmo banco isolado, e repete
as corridas distribuindo as requisições em rodízio: 100/80/80, a mesma aposta 60 vezes,
30 apostas disputando o saldo, REFUNDs simultâneos, criação simultânea da mesma wallet,
wallets independentes e replay por instância diferente da que processou.

**Consequências.** Escalar a API é aumentar réplicas. O limite passa a ser o PostgreSQL
primário e, por wallet, o lock de linha (ADR-010).

### ADR-013 — Consumer SQS: inbox transacional, ack após o commit e classificação de erros

**Status:** Aceito

**Decisão.**

- O consumer reutiliza o `ProcessWagerTransactionUseCase` da API. A mensagem é registrada
  na inbox (`INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`) dentro da
  MESMA transação do efeito financeiro, antes do lock da wallet. Com inbox, o fast path de
  idempotência é pulado: o replay também registra a mensagem, na transação principal.
- `WagerMessageHandler` decide; `SqsPollingConsumer` executa:

| Desfecho                                                                                        | Decisão     | Execução                                                 |
| ----------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| PROCESSED, REJECTED, PENDING_REFERENCE                                                          | ack         | `DeleteMessage` após o handler (logo, após o COMMIT)     |
| Reentrega já vista (mesmo messageId e conteúdo)                                                 | ack         | `DeleteMessage`                                          |
| Mensagem inválida, `DomainError` (400/404/409 na API), messageId reutilizado com outro conteúdo | dead-letter | `SendMessage` à DLQ com motivo + `DeleteMessage`         |
| Falha transitória ou erro inesperado                                                            | retry       | `ChangeMessageVisibility` com backoff (1 s, 2 s... 60 s) |
| Retry na tentativa `maxReceiveCount`                                                            | dead-letter | `RETRIES_EXHAUSTED`, com o último erro                   |

- Mensagens do mesmo `MessageGroupId` (= walletId) em sequência; grupos em paralelo.
  Um retry devolve as seguintes do mesmo grupo, preservando a ordem.
- A DLQ recebe o corpo original e atributos `dlq-reason`, `dlq-detail`,
  `original-message-id` e `receive-count`. A redrive policy da fila é a rede de segurança.
- Ativado só nas instâncias com o papel `consumer`. Para no `beforeApplicationShutdown`,
  antes do pool do banco fechar: termina as mensagens em andamento (até 20 s) e devolve
  as não iniciadas com visibilidade 0.

**Por que DomainError vai para a DLQ e não para o ack.** Na API, esses erros voltam ao
provedor como 400/404/409. Na fila não há resposta: um ack descartaria a mensagem em
silêncio; a DLQ a preserva para investigação.

**Verificação.**

- Handler (só banco): deduplicação, reentregas simultâneas, classificação, inbox desfeita
  junto com o efeito numa falha transitória.
- Ponta a ponta (fila real, filas exclusivas por suíte): processamento, duplicata, rejeição,
  ordem por grupo, DLQ imediata, retry com recuperação, instância sem o papel.
- Resiliência (processos reais): SIGKILL entre o commit e o ack (ponto de injeção de falha
  determinístico via `FAULT_INJECTION`), SIGTERM com mensagem em andamento, esgotamento de
  tentativas.
### ADR-014 — Transactional outbox com relay por lease

**Status:** Aceito

**Decisão.**
- O caso de uso grava os eventos na outbox na MESMA transação do efeito financeiro;
  nada é publicado antes do commit, porque quem publica é o relay, lendo o que já foi confirmado.
- Cada rodada do relay: (1) reserva um lote com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
  SKIP LOCKED) RETURNING`, gravando um lease (`locked_until`, `locked_by`); (2) publica fora de
  transação; (3) marca os publicados e agenda os que falharam, em transação curta.
- Publicação no `wallet-events.fifo` com `SendMessageBatch`: `MessageGroupId` = aggregateId
  (ordem por wallet), `MessageDeduplicationId` = eventId, corpo = envelope gravado.
- Falha de publicação: backoff de 1 s até 5 min, sem limite de tentativas (evento confirmado
  não pode ser perdido). Broker fora do ar: o lote inteiro entra no backoff.
- Worker ativado pelo papel `relay`; para no `beforeApplicationShutdown`.

**Por que lease e não lock de transação durante a publicação.** Segurar uma transação aberta
durante I/O de rede prenderia uma conexão do pool pelo tempo da chamada ao broker. O lease
é gravado na linha e vale sem conexão aberta; se o relay morrer, ele vence e outro assume.

**Garantia de entrega: at-least-once.** Publicar no broker e marcar no banco não podem ser
atômicos. Se o relay morrer entre os dois, o evento é publicado de novo, com o mesmo eventId.
O SQS FIFO descarta a cópia dentro de 5 minutos (otimização); a garantia é o consumidor
deduplicar pelo eventId.

**Limitações.**
- Relays diferentes podem publicar eventos da mesma wallet fora de ordem; os eventos carregam
  `walletVersion` para o consumidor ordenar e descartar obsoletos.
- O lease usa o relógio de cada instância; uma diferença de relógio maior que o lease (30 s)
  poderia gerar publicação duplicada, já tolerada.

**Verificação.**
- Lógica (banco real, publicador em memória): ordem, 4 relays e 200 eventos sem duplicata,
  lease, relay morto antes e depois de publicar, falha parcial, broker fora do ar.
- Ponta a ponta (fila real): uma aposta vira eventos no `wallet-events.fifo`; corpo idêntico
  ao gravado; instância sem o papel não publica.
- Resiliência (processos reais): o cenário do enunciado (commit confirmado, relay morto antes
  de publicar, outra instância assume e publica), relay morto depois de publicar
  (republicação segura) e 3 relays em processos separados sem perda.
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

| Resultado               | HTTP | Eventos                                              |
| ----------------------- | ---- | ---------------------------------------------------- |
| PROCESSED com movimento | 200  | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| PROCESSED (LOSS)        | 200  | `WagerTransactionProcessed`                          |
| REJECTED                | 422  | `WagerTransactionRejected`                           |
| PENDING_REFERENCE       | 202  | `WagerTransactionPendingReference`                   |

O mesmo caso de uso atende HTTP e SQS (`causationId` = messageId).
