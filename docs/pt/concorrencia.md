# Concorrência: duas apostas disputando a mesma wallet

Cenário obrigatório do enunciado: saldo inicial `100.00 BRL`, duas apostas de `80.00 BRL`
processadas **simultaneamente** (por qualquer combinação de instâncias). Resultado esperado:
exatamente uma `PROCESSED`, a outra `REJECTED` por `INSUFFICIENT_FUNDS`, saldo final `20.00`,
exatamente **um** lançamento `DEBIT`.

A unidade de concorrência é a `walletId`. A estratégia é lock pessimista (`SELECT ... FOR UPDATE`)
mais uma checagem otimista de `version` no `UPDATE` — cinto e suspensório (ADR-010 no
`ARCHITECTURE.pt.md`).

```mermaid
sequenceDiagram
    autonumber
    participant A as Instância 1 — aposta A (80.00)
    participant DB as PostgreSQL (linha da wallet)
    participant B as Instância 2 — aposta B (80.00)

    par chegam ao mesmo tempo
        A->>DB: BEGIN, SELECT ... FOR UPDATE WHERE id = wallet
    and
        B->>DB: BEGIN, SELECT ... FOR UPDATE WHERE id = wallet
    end

    Note over DB: só uma linha, só um lock —<br/>o Postgres serializa as duas

    DB-->>A: lock concedido (balance=100.00, version=1)
    Note over B: B fica bloqueada esperando<br/>o lock_timeout da transação

    A->>A: WagerSettlement.decide():<br/>canDebit(80.00)? sim
    A->>DB: UPDATE wallets SET balance=20.00, version=2<br/>WHERE id=wallet AND version=1
    A->>DB: INSERT wager_transactions (status=PROCESSED)
    A->>DB: INSERT wallet_ledger_entries (DEBIT, 80.00)
    A->>DB: COMMIT
    Note over DB: lock liberado

    DB-->>B: lock concedido (balance=20.00, version=2 — já atualizado)
    B->>B: WagerSettlement.decide():<br/>canDebit(80.00)? NÃO (só 20.00 disponível)
    B->>DB: INSERT wager_transactions (status=REJECTED,<br/>failureCode=INSUFFICIENT_FUNDS)
    Note over B: sem UPDATE em wallets,<br/>sem lançamento no ledger
    B->>DB: COMMIT

    Note over DB: saldo final 20.00 · version=2 ·<br/>exatamente 1 lançamento DEBIT
```

## Por que isso continua correto com 3+ instâncias

O diagrama acima não muda nada se "Instância 1"/"Instância 2" forem processos de sistema
operacional completamente diferentes, cada um com seu próprio pool de conexão — o ponto de
serialização é a **linha do Postgres**, não memória compartilhada da aplicação. Nenhuma
instância guarda estado de negócio em memória (ADR-012); qualquer réplica atende qualquer
requisição.

```mermaid
flowchart LR
    Cliente -->|rodízio| I1["Instância 1<br/>(processo 1)"]
    Cliente -->|rodízio| I2["Instância 2<br/>(processo 2)"]
    Cliente -->|rodízio| I3["Instância 3<br/>(processo 3)"]
    I1 --> PG[("PostgreSQL<br/>lock por walletId")]
    I2 --> PG
    I3 --> PG
```

## O que acontece se o lock demorar demais

Cada transação tem seu próprio `lock_timeout`/`statement_timeout` (`MikroTransactionManager`).
Se o lock não for concedido a tempo (hot wallet sob carga extrema, ou um bug segurando a
transação por tempo demais), o Postgres cancela com SQLSTATE `55P03`
(`isTransientDatabaseError`/`isLockConflict` em `pg-error.ts`) e a aplicação responde **503**
com `Retry-After`, sem efeito nenhum — nunca trava a instância inteira esperando pra sempre. Isso
também incrementa a métrica `database_lock_conflicts_total` (ver
[observabilidade.md](./observabilidade.md)).

## Onde isso é provado

| Teste | Granularidade |
|---|---|
| `test/concurrency/single-instance.test.ts` | Mesmo processo, `Promise.all` real |
| `test/concurrency/multi-instance.test.ts` | **3 processos de SO reais** (`bun src/main.ts`), mesmo banco |
| `test/integration/http/wagering.http.test.ts` | Versão HTTP do cenário, fim a fim |
| `test/resilience/restart-consistency.test.ts` | O mesmo princípio, sob `SIGKILL`/`SIGTERM` reais |

Invariante final verificada em todos: `wallet.balance == saldo reconstruído pelo ledger`
(`test/support/invariants.ts`).
