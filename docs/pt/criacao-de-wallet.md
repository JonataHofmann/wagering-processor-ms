# Criação de wallet

`POST /wallets` — `src/modules/wallet/presentation/controllers/wallets.controller.ts` →
`src/modules/wallet/application/use-cases/create-wallet.use-case.ts`

Quando o saldo inicial é maior que zero, a abertura gera uma transação interna `OPENING`
(a única forma de `OPENING` existir — nunca é submetida pela API nem pela fila) com um
lançamento `CREDIT` correspondente, e os dois eventos de integração — tudo na **mesma
transação SQL** que insere a wallet.

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant Ctrl as WalletsController
    participant UC as CreateWalletUseCase
    participant W as Wallet (domínio)
    participant TM as TransactionManager
    participant DB as PostgreSQL

    C->>Ctrl: POST /wallets { playerId, initialBalance }
    Ctrl->>UC: execute(command)
    UC->>UC: Money.from(initialBalance)<br/>(INVALID_AMOUNT/INVALID_CURRENCY se inválido)
    UC->>W: Wallet.open({ id, playerId, initialBalance })
    W-->>UC: { wallet (version=1), openingEntry? }

    UC->>TM: runInTransaction(...)
    activate TM
    TM->>DB: INSERT wallets (...)
    Note over DB: UNIQUE(player_id, currency)<br/>violada → 409 WALLET_ALREADY_EXISTS

    alt initialBalance == 0 (openingEntry undefined)
        Note over UC: nada mais a gravar:<br/>sem transação, sem ledger, sem evento
    else initialBalance > 0
        UC->>UC: WagerTransaction.createOpening(...)<br/>markProcessed(...)
        UC->>DB: INSERT wager_transactions (kind=OPENING, status=PROCESSED)
        UC->>DB: INSERT wallet_ledger_entries (direction=CREDIT)
        UC->>DB: INSERT outbox (WagerTransactionProcessed, WalletBalanceChanged)
    end
    deactivate TM

    UC-->>Ctrl: WalletView
    Ctrl-->>C: 201 { id, playerId, balance, version: 1, ... }
```

## Pontos importantes

- **`providerId` da transação OPENING é `"system"`**, reservado — nenhum provedor real pode
  usá-lo (`RESERVED_PROVIDER` se tentar).
- **Saldo zero não cria rastro nenhum**: sem `wager_transactions`, sem `wallet_ledger_entries`,
  sem evento — só a linha em `wallets`, com `version = 1`.
- A publicação de verdade na fila (`wallet-events.fifo`) **não acontece aqui**: os eventos só
  viram linhas na tabela `outbox`; quem publica é o relay (ver
  [outbox-transacional.md](./outbox-transacional.md)).
- Conflito de wallet duplicada (mesmo `playerId` + `currency`) é pego pela constraint
  `uq_wallets_player_currency` do banco, não só por uma checagem em memória — por isso é seguro
  mesmo com duas instâncias criando a mesma wallet ao mesmo tempo.
