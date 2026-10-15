# ARCHITECTURE

Distributed financial service that processes wager transactions (BET, WIN, LOSS, REFUND, ROLLBACK) received from multiple providers, via HTTP and SQS, with at-least-once delivery.

Financial correctness is guaranteed by **PostgreSQL**, not by the broker nor by memory. The domain code decides; the database refuses any inconsistent state that escapes the code.

> This document grows alongside the implementation. Decisions already implemented are marked as **Accepted**; decisions designed but not yet implemented, as **Proposed**.

---

## 1. Implementation status

| Phase                        | Step                                                   | Status                     |
| --------------------------- | ------------------------------------------------------- | -------------------------- |
| Foundation                    | 1. Repository (Bun + NestJS + strict TypeScript)      | Done                  |
|                             | 2. Local infrastructure (PostgreSQL + LocalStack SQS)   | Done                  |
|                             | 3. MikroORM and migration runner                      | Done                  |
|                             | 4. Schema, constraints, triggers, permissions and tests   | Done                  |
| Pure domain                | 5. `Money`                                              | Done                  |
|                             | 6. `Wallet` and `WalletLedgerEntry`                       | Done                  |
|                             | 7. `WagerTransaction`                                     | Done                  |
|                             | 8. `InboxMessage` and `OutboxMessage`                     | Done                  |
| Persistence and use cases | 9 to 12 (use cases, HTTP, SQS consumer)               | Done                  |
| Instances and messaging     | 13 to 16 (multiple instances, outbox relay, scheduler) | Done                  |
| Final guarantees              | 17 to 20 (concurrency, resilience, reconciliation)      | Done                  |
| Delivery                 | 21 to 23 (observability, documentation, polish)      | Done, except for the below |

---

## 2. Stack

| Item                                  | Choice                    | Note                                                                                       |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| Runtime, package manager, test runner | Bun 1.x                    | Bun executes TypeScript but does not type-check: `bun run typecheck` (`tsc --noEmit`) is mandatory |
| Language                             | TypeScript in strict mode | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`                                       |
| Framework                             | NestJS                     | Used only at the edges (HTTP, DI, lifecycle). The domain does not depend on it                        |
| Database                                 | PostgreSQL 16              |                                                                                                  |
| ORM                                   | MikroORM 7.2.5             | Migrator API: `orm.migrator`, `getExecuted()`, `getPending()`, `create()`                     |
| Messaging                            | AWS SQS via LocalStack 3.8 | Pinned version; recent image versions require a token                                              |
| Money                              | `decimal.js`               | Encapsulated in `Money`; never exposed                                                          |
| Local orchestration                    | Docker Compose             |                                                                                                  |

---

## 3. Architecture overview

```
Providers ──HTTP──▶  ┌──────────────────────────────────────────────┐
                     │  NestJS app (same image, N replicas)         │
SQS ──────────────▶  │  every replica does everything: serves HTTP, │
                     │  consumes, publishes the outbox and schedules│
                     │                                              │
                     │  Application (use cases)                     │
                     │  Domain (pure: Money, Wallet, Transaction)   │
                     │  Infrastructure (MikroORM, SQS)              │
                     └───────────────┬──────────────────────────────┘
                                     ▼
                     PostgreSQL: wallets · wager_transactions ·
                     wallet_ledger_entries · inbox · outbox
```

- **Modular monolith** with N stateless replicas (ADR-001).
- **Hexagonal architecture**: pure domain, use cases with ports, adapters in the infrastructure (ADR-002).
- **A single transactional database**: balance, ledger, transaction, inbox and outbox change within the same SQL transaction.

---

## 4. Architectural decisions

### ADR-001 — Modular monolith with N stateless replicas

**Status:** Accepted

**Context.** Balance, ledger, transaction, inbox and outbox need to change atomically. The domain has a single transactional bounded context: the wallet.

**Decision.** A single NestJS image, organized into modules (`wallet`, `wagering`, `messaging`, `shared`, `platform`). Every replica runs everything at the same time — serves HTTP, consumes `wager-transactions.fifo`, publishes the outbox and resolves `PENDING_REFERENCE` — with no configuration or role to choose. All coordination between replicas happens in PostgreSQL (`SKIP LOCKED`, lease, constraints).

**Discarded alternative.** Separate microservices for wallet and wagering would require a saga or 2PC within a single balance movement. Also discarded: instances with fixed roles via environment variable — it would add a configuration axis with no real need, since each worker already knows how to stay idle on its own when there's nothing to do.

**Consequences.** Atomicity with a single local transaction. Horizontal scaling for distinct wallets; the limit becomes the primary PostgreSQL. Bringing up one more replica increases capacity across all fronts at once (HTTP, consumption, publishing, scheduling) — there's no way to scale one front in isolation without separating deployments.

### ADR-002 — Hexagonal architecture with pure domain

**Status:** Accepted (structure);

**Decision.**

- Layers per module: `domain` (no NestJS or ORM imports), `application` (use cases and ports), `infrastructure` (adapters).
- Private constructors and static factories (`from`, `create`, `open`, `rehydrate`). `rehydrate` reconstructs persisted state without revalidating transitions.
- Business rule errors inherit from `DomainError`, with a stable, machine-readable `code`.

**Consequences.** The domain is tested in milliseconds, without a database. The cost is mapping code between domain and persistence.

### ADR-003 — MikroORM 7 with hand-written migrations

**Status:** Accepted

**Context.** The schema uses features that the ORM's migration generator cannot express: domains with CHECK, partial unique indexes, deferred constraint triggers, GRANTs.

**Decision.**

- Hand-written migrations (`snapshot: false`), one per responsibility, all with `up()` and `down()`.
- `transactional: true` and `allOrNothing: true`: a batch of migrations applies in full or not at all.
- `disableForeignKeys: false`: the default mode of disabling FKs on Postgres (`session_replication_role = replica`) would also disable the integrity triggers.
- Programmatic runner (`scripts/migrate.ts`) instead of the Mikro CLI, for compatibility with Bun.
- Writing rules: one statement per `addSql`, no `?` in the SQL.

**Consequences.** Every new table requires a manual migration and the corresponding GRANT.

### ADR-004 — Exact monetary representation

**Status:** Accepted

**Decision.**

- Immutable `Money` (`Object.freeze`), encapsulating an isolated `Decimal` constructor (`Decimal.clone`), without altering `decimal.js`'s global configuration.
- Input is validated by regex **before** reaching `decimal.js`, which would accept `1e3`, `NaN` and `Infinity`.
- Output always with 2 decimal places (`"25.00"`). Sums and subtractions of values with 2 decimal places are exact; nothing rounds. `ROUND_HALF_EVEN` is configured for eventual future use in division.
- In the database: domain `money_amount` (`numeric` with no fixed scale, with `CHECK (scale(VALUE) <= 2)`) and `currency_code` (`char(3)` uppercase).
- Contracts and events carry `MoneyProps` (`{ amount: string, currency: string }`), never the instance.

**Discarded alternatives.**

- `numeric(20,2)` silently rounds `10.005` to `10.01`, hiding parser bugs.
- An integer in cents couples the scale to the currency and requires conversion at every boundary.

**Interpretations adopted.**

- Input with 0 or 1 decimal place (`"25"`, `"25.5"`) is accepted and normalized to 2 decimal places. The spec forbids more than 2 decimal places; fewer is not ambiguous. The canonical form is the only one that circulates internally and enters the `payloadHash`.
- Ambiguous formats are rejected: explicit sign, `.5`, `5.`, leading zeros, comma, spaces. Limit of 18 integer digits, matching the database domain.
- Negatives are forbidden on input (`Money.from`) and allowed as an internal result of `subtract` and `negate`, so the domain can express "would the balance go negative?".
- `equals` between different currencies returns `false`; `add`, `subtract` and `isLessThan` throw `CurrencyMismatchError`.
- Currencies with 0 or 3 decimal places (JPY, KWD) would require per-currency scale. Out of scope.

### ADR-005 — Financial invariants guaranteed in the schema

**Status:** Accepted

**Context.** The spec requires uniqueness, immutability and non-negativity in the database, not only in code. Code has bugs; with multiple instances, only the database can guarantee uniqueness.

**Decision.** The code governs, the database guarantees:

| Layer  | Role                                                    | When it acts              |
| ------- | ------------------------------------------------------ | ----------------------- |
| Domain | Decides and produces (balance, entry, status, failureCode) | Always                  |
| Database   | Verifies and refuses                                        | Only when the code errs |

The triggers **never write data**. A `WL00x` error in production indicates a bug, not a business rule.

| Code  | Trigger / function                                                                                                                                | Fires when                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WL001` | `trg_ledger_no_update_delete`, `trg_ledger_no_truncate` (`fn_ledger_append_only`)                                                               | `UPDATE`, `DELETE` or `TRUNCATE` on `wallet_ledger_entries` — the ledger is append-only, not even the owner alters it                                                                                                                                                                                                                                                                                        |
| `WL002` | `trg_wallets_ledger_consistency`, `trg_ledger_transaction_consistency`, `trg_wtx_ledger_consistency` (constraint triggers, deferred to COMMIT) | Wallet balance/version changes without a corresponding entry (or vice versa); entry whose amount, currency, wallet or direction doesn't match its transaction; `PROCESSED` transaction without an entry (or vice versa)                                                                                                                                                                                   |
| `WL003` | `trg_wtx_guard` (`fn_wtx_guard`)                                                                                                                | `DELETE` on `wager_transactions`; `UPDATE` of a transaction that's already terminal (`PROCESSED`/`REJECTED`/`FAILED`); going back from `PENDING_REFERENCE` to `PENDING`; changing any column outside the set that the pending-reference flow is allowed to change (`status`, `failure_code`, `balance_snapshot`, `attempts`, `next_attempt_at`, `expires_at`, `reference_transaction_id`, `updated_at`, `processed_at`) |
| `WL004` | `trg_wallets_immutable` (`fn_wallet_immutable_fields`)                                                                                          | `UPDATE` that changes `id`, `player_id`, `currency` or `created_at` of a wallet                                                                                                                                                                                                                                                                                                                   |

**Why** `UNIQUE (id, currency)` **on** `wallets`**, besides the primary key on** `id`**.** It exists only to be the target of a composite foreign key: `wallet_ledger_entries` references `wallets (id, currency)` via `fk_ledger_wallet_currency`, not just `wallet_id → wallets(id)`. With a simple FK the database would accept a USD entry on a BRL wallet; the composite FK makes that unrepresentable. Discarded alternatives: not storing `currency` in the ledger (the entry would stop being self-sufficient, requiring a JOIN with `wallets` to reconstruct the `Money` or to audit it in isolation) and validating the currency via trigger (procedural code for something a declarative FK already solves, more simply and faster).

**Interpretation adopted.** A reference can only be reversed **once in total**, via REFUND or ROLLBACK. The literal reading ("once per operation type") would allow a REFUND followed by a ROLLBACK of the same BET, crediting the amount twice and violating the global invariant against duplicate credits.

**Consequences.** Cost of a few unique-index lookups on every financial write. `WL002` errors surface at COMMIT, so error handling needs to account for the commit.

### ADR-006 — Two database roles (least privilege)

**Status:** Accepted

**Context.** The image's `POSTGRES_USER` is a superuser and ignores GRANTs.

**Decision.**

- `wagering_owner`: schema owner; used only by migrations (`DATABASE_MIGRATION_URL`).
- `wagering_app`: the only role used at runtime (`DATABASE_URL`), created by `docker/postgres/init/01-roles.sql` with no privileges; receives only what's necessary in migration 4.
- The role is created at container init (it belongs to the cluster, not the database); per-table permissions live in the migration (they depend on the tables).
- No `ALTER DEFAULT PRIVILEGES`: every new table receives an explicit GRANT.
- Permissions are not the same across all tables — each receives only the verb its role requires:

| Table                                            | Permissions                             | Why                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallets`, `wager_transactions`, `inbox_messages` | `SELECT`, `INSERT`, `UPDATE`           | Operational tables: they change state, but a row is never deleted                                                                                      |
| `outbox_messages`                                 | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | An already-published event can be cleaned up                                                                                                                        |
| `wallet_ledger_entries`                           | `SELECT`, `INSERT`                     | Ledger is append-only: `wagering_app` has no `UPDATE` or `DELETE` — the permission itself already prevents alteration, even before the `WL001` trigger kicks in |

**Consequences.** The ledger is protected by two independent layers: permission (`42501`) and trigger (`WL001`).

### ADR-007 — Testing strategy: real infrastructure, isolated database and verified concurrency

**Status:** Accepted (unit, schema, persistence, HTTP and concurrency layers in a single process);
extended in steps 13 to 18 (multiple instances, failures and restart)

**Context.**
The spec rules out solutions whose tests completely replace PostgreSQL and SQS with mocks,
requires concurrency tests with real parallelism (not sequential mocks), and defines as the
final invariant of all tests: `wallet.balance == balance reconstructed from the ledger`.
The system's most important guarantees (uniqueness, immutability, non-negativity,
serialization per wallet) live in the database; only a real database can prove them.

**Decision.**

1. **Layered pyramid, each layer proving what only it can prove.**

| Layer       | Folder                          | Infrastructure                   | Proves                                                                                                             |
| ------------ | ------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Unit     | `test/unit`                    | None                          | Domain rules: `Money`, `Wallet`, `WagerTransaction`, reference policy, backoff, canonical hash, events |
| Schema       | `test/integration/schema`      | PostgreSQL                       | The database alone refuses invalid states: constraints, triggers, permissions, reversible migrations               |
| Persistence | `test/integration/persistence` | PostgreSQL                       | Round trip domain ↔ database, transaction, lock, atomicity across repositories                                      |
| HTTP         | `test/integration/http`        | PostgreSQL + real Nest application | API contract, HTTP status, idempotency, end-to-end business rules                                                |
| Concurrency | `test/concurrency`             | PostgreSQL + real Nest application | Real races: serialization per wallet, idempotency under contention, lock timeout                                    |

1. **Real infrastructure, never simulated.**

- Integration and concurrency tests run against the Docker Compose PostgreSQL
  (and against LocalStack from step 14 onward).
- The HTTP tests bring up the full Nest application (`AppModule.register`) on a free port
  (`listen(0)`) and talk to it via `fetch`: error filter, controller, use case,
  repositories, MikroORM, PostgreSQL and triggers, with nothing replaced.
- The domain is tested without infrastructure because it is pure (ADR-002), not because something was mocked.

2. **One isolated database per suite, copied from a template.**

- `test/support/database.ts` migrates `wagering_test_template` only once per
  `bun test` run and creates each suite's database with `CREATE DATABASE wg_test_<uuid> TEMPLATE ...`
  (milliseconds, complete with tables, triggers, domains and permissions).
- Each database is dropped in `afterAll` (`DROP DATABASE ... WITH (FORCE)`).
- Tests never touch the development `wagering` database.

3. **Tests connect as the application does.**

- The tests' MikroORM uses `wagering_app` (`TEST_DATABASE_APP_URL`), with exactly the
  production permissions. The owner is only used where a test needs to prove that even it is
  blocked by the triggers.

4. **Assertions by code, not by text.**

- Database errors are compared by SQLSTATE (`23505`, `23514`, `23503`, `42501`,
  `WL001`–`WL004`) via `sqlState()`, never by message, which changes with version and locale.
- API errors are compared by HTTP status and `error.code`.

5. **Each constraint test violates a single rule.**
   PostgreSQL checks in fixed order (CHECK → UNIQUE → FOREIGN KEY → deferred triggers
   at COMMIT) and stops at the first failure. Data that violates two rules makes the test depend
   on that order and fails to prove what it claims to prove.
6. **Concurrency with real parallelism and repetition.**

- Simultaneous HTTP requests (`Promise.all`), each with its own pool connection and its own
  PostgreSQL transaction.
- Each race is repeated `CONCURRENCY_ITERATIONS` times (default 10; verified with 50),
  because a race that passes once may have just gotten lucky.
- Assertions against the database (entry count by direction), not just against the responses:
  a duplicate debit shows up in the ledger even if the response looks correct.
- Locks held from outside the application (`connectPersistence` over the same database) to
  prove behavior under waiting: per-wallet lock and `lock_timeout`.

7. **Final invariant across all suites that move balance.**
   `walletsInconsistentWithLedger()` (`test/support/invariants.ts`) compares, in a single query,
   each wallet's balance against the signed sum of its ledger. `afterAll` requires an empty list.
8. **Determinism.**

- Injectable `Clock` and `IdGenerator`; in domain and persistence tests, `FixedClock`
  and `SequentialIdGenerator` make dates and ids predictable.
- Backoff accepts `jitter: 'none'` or an injected random source.
- Each test creates its own data (wallets and players with a new UUID), without depending
  on execution order.

9. **Every important test goes through a "sabotage experiment".**
   When writing a guarantee test, the corresponding rule is deliberately turned off
   (trigger commented out, lock removed, `.sort()` removed from the hash, idempotency
   re-check commented out) to confirm the test fails. A test that never fails
   proves nothing.

**Test helpers.**

| Helper                            | Role                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `test/support/database.ts`        | Template, per-suite isolated database, `runMigrations`                                               |
| `test/support/pg.ts`              | `inTx`, `sqlState`, `queryOnce`                                                                  |
| `test/support/schema-fixtures.ts` | Valid data written directly to the database for schema tests                                           |
| `test/support/persistence.ts`     | `createPersistence` (own database) and `connectPersistence` (database shared with the application) |
| `test/support/http-app.ts`        | Brings up the real application against an isolated database                                                |
| `test/support/wagering-client.ts` | API client reused by HTTP and concurrency tests                                                 |
| `test/support/invariants.ts`      | Balance = ledger invariant for all wallets                                                            |
| `test/support/fakes.ts`           | `FixedClock`, `SequentialIdGenerator`                                                            |
| `scripts/checks/sql/*.sql`        | Manual schema verification scripts (debugging and presentation)                                             |
| `bun run test:resilience`         | Failures with real processes (slow: waits on timeouts)                                              |

**Concurrency matrix (step 12).**

| Scenario                            | What it proves                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| 100.00 with two bets of 80.00   | One PROCESSED, one REJECTED, balance 20.00, one debit          |
| 30 bets of 10.00 against 100.00   | 10 accepted and unique observed balances: serialized decisions |
| Simultaneous BET, WIN and LOSS        | Final balance = exact sum of accepted operations               |
| The same bet 50 times            | One debit, 49 replays, a single `transactionId`                |
| The same key on different wallets  | `UNIQUE` decides; the losers receive 409                        |
| Simultaneous REFUNDs on the same BET   | Only one refunds; the rest get `REFERENCE_ALREADY_REVERSED`        |
| Simultaneous creation of the same wallet | One 201, the rest 409                                        |
| 20 wallets in parallel              | Each one settles correctly, independently                           |
| Wallet A locked, bet on B      | B responds immediately: the lock is per wallet, never global       |
| Waiting beyond `lock_timeout`      | 503 + `Retry-After`, nothing written, the retry gets processed           |

**Coverage of the spec's mandatory tests.**

| Required                                                                        | Status                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `Money` operations and validations (scale, rounding, invalid inputs) | Covered (unit)                                                    |
| `Wallet` invariants                                                        | Covered (unit)                                                    |
| BET, WIN, LOSS, REFUND, ROLLBACK rules                                     | Covered (unit and HTTP)                                             |
| Currency conflict                                                              | Covered (unit and HTTP)                                             |
| Idempotency key with divergent payload                                         | Covered (unit and HTTP)                                             |
| Migrations and constraints                                                       | Covered (schema)                                                      |
| Atomicity across wallet, ledger, inbox and outbox                               | Covered (persistence and HTTP)                                         |
| The same bet 50 times in parallel                                            | Covered (concurrency)                                                |
| Contention over the same wallet's balance                                             | Covered (concurrency)                                                |
| Distinct wallets in parallel                                                  | Covered (concurrency)                                                |
| ≥ 3 processes or instances                                                     | Step 13                                                              |
| Inbox, redelivery, retry and DLQ                                                 | Step 14                                                              |
| Worker killed after the commit and before the ack                                   | Step 14                                                              |
| Concurrent publishers over the same outbox                                           | Step 15                                                              |
| ROLLBACK or REFUND ahead of the reference (processed later)               | Step 16                                                              |
| Service restart with eventual consistency                                     | Covered (resilience: mixed load, SIGKILL, SIGTERM and full restart) |
| Inbox, redelivery, retry and DLQ                                                 | Covered (handler, end-to-end and resilience)                        |
| Worker killed after the commit and before the ack                                   | Covered (resilience, real SIGKILL)                                   |
| **Commands.**                                                                  |                                                                       |

| Command                                                                | Runs                         |
| ---------------------------------------------------------------------- | ---------------------------- |
| `bun run test:unit`                                                    | Domain, no infrastructure  |
| `bun run test:integration`                                             | Schema, persistence and HTTP  |
| `bun run test:concurrency`                                             | Races in a single process      |
| `CONCURRENCY_ITERATIONS=50 bun test --timeout 300000 test/concurrency` | Races with more repetitions |
| `MIKRO_ORM_DEBUG=true bun run test:concurrency`                        | Same, showing the queries   |

**Discarded alternatives.**

- **Database or repository mocks in integration tests:** forbidden by the spec and
  unable to prove constraints, triggers, locks and atomicity.
- `TRUNCATE` **between tests:** impossible by design, because the ledger blocks TRUNCATE.
- **One rolled-back transaction per test:** doesn't work for concurrency (multiple connections) nor
  for deferred triggers (they only fire at COMMIT).
- **Testcontainers per suite:** maximum isolation, but slow boot per suite and uncertain
  support on Bun. The template on the same PostgreSQL gives equivalent isolation in milliseconds.

**Consequences.**

- The integration and concurrency suite requires Docker to be running and takes seconds, not
  milliseconds.
- In exchange, every guarantee the spec evaluates has a test that would fail if it broke,
  run against the same infrastructure production would use.
- A database left behind by an interrupted test (`Ctrl+C`) may remain; manual cleanup is
  documented in the README.

**Restart test (**`restart-consistency.test.ts`**).** Three instances (every instance does everything)
receive mixed load across 12 wallets (HTTP and queue, out-of-order references on both channels,
duplicate message delivery) while one instance dies via SIGKILL, another receives
SIGTERM, and finally all die via SIGKILL and the service is restarted. The HTTP client resends
the same request to another instance on failure, like a real provider would.

The operations plan allows no rejections, so each wallet's final balance is known
beforehand (959.00, version 14). After convergence (with no intervention), the test proves:
exact final balance on every wallet; one transaction per operation, all PROCESSED; one
entry per movement and balance = ledger; each message exactly once in the inbox, empty DLQ and
queue; the entire outbox published and present on the broker; and `bun run reconcile` with exit 0.

### ADR-008 — Authentication: deferred, prepared via Port/Adapter

**Status:** Accepted (structure); real integration with Keycloak **not implemented**

**Context.** Section 2 of the spec zeroes out the authentication score on purpose, so it doesn't
compete with financial correctness, concurrency and idempotency within the timebox. At the same time,
it requires that, if choosing not to implement it, the decision be documented here, with the design that
would be adopted and an explicit extension point in the code — that's what this ADR records.

**Decision.**

- `ProviderIdentityPort` (`src/platform/auth/provider-identity.port.ts`): pure contract,
  no import from NestJS or Keycloak — `authenticate(token?: string): Promise<ProviderIdentity>`,
  where `ProviderIdentity = { subject, providerId, roles }` (`subject` equivalent to the claim
  `sub` of a JWT).
- `NoOpProviderIdentityAdapter`: **temporary** implementation, never validates a token, never
  queries Keycloak, never does I/O — always returns the same fictitious identity
  (`local-service-account` / `development-provider` / `['provider']`).
- `ProviderAuthGuard` extracts the token from the `Authorization: Bearer <token>` header (when
  present), delegates to the Port, and makes the identity available at `request.providerIdentity`;
  it doesn't know about Keycloak nor validate a JWT signature. Authentication failure becomes
  `UnauthorizedException`.
- `CurrentProvider()`: a parameter decorator that reads the identity from the request — never from the
  `providerId` the client sent in the body. Throws if used without the Guard in front (a programming
  error, not a business path).
- `AuthModule.forRoot(config)`: a `@Global()` module, binds `PROVIDER_IDENTITY_PORT` to the
  right adapter according to `AuthConfig.mode`. Today only `case 'noop'` exists in the
  `useFactory` — swapping in the Keycloak adapter is the only change needed; Guard, decorator and any
  controller stay the same.
- `AUTH_MODE` **has no implicit fallback**: absent, the boot fails. `AUTH_MODE=noop` is only
  accepted with `NODE_ENV=development|test`; under any other `NODE_ENV` the application refuses
  to start. `AUTH_MODE=keycloak` fails explicitly ("not yet implemented"), instead of
  letting through a half-done validation (`src/platform/auth/auth.config.ts`).
- **No existing controller uses the Guard today.** Wiring `@UseGuards(ProviderAuthGuard)` into the
  `wagering`/`wallet` endpoints is a product decision (which routes require provider
  identity) and a contract change (the body's `providerId` would stop being trusted, it would come from
  `@CurrentProvider()`) — out of scope for this step, which only prepares the structure.
  `/health/*` and `/metrics` remain always open, as the spec requires.

**Design of the future Keycloak integration** (not implemented now):

- Validate the JWT signature with the realm's JWKS public keys, with caching and key
  rotation (no HTTP call to Keycloak on every request).
- Validate `iss`, `aud`, `exp` and other relevant claims.
- Extract `sub` as `subject`; map `providerId` from a trusted claim or an
  internal mapping; extract `roles` from realm/client roles.
- Reject an invalid, expired token or one without the required permission.

**Limitations of no-op mode.** It doesn't authenticate anything for real — any caller receives the
same fictitious identity. That's why the `NODE_ENV` guard exists: the mode can never be
enabled outside `development`/`test`, even by mistake.

**Consequences.** The domain and use cases never depend on Keycloak or JWT —
only on the `ProviderIdentity` the Port returns. Swapping the adapter is the only change needed
when the real integration is built.

### ADR-009 — Application layer and HTTP error contract

**Status:** Accepted (wallets); extended in step 11 (transactions)

**Decision.**

- Use cases are plain classes, assembled by the Nest modules via `useFactory`
  and injected through the port tokens.
- The global `PersistenceModule` composes ORM, transaction, clock, ids and repositories.
  `AppModule.register({ databaseUrl })` receives the configuration as a parameter.
- `@mikro-orm/nestjs` is not used: `MikroORM` comes from a dedicated provider,
  closed on shutdown (`OnApplicationShutdown`).
- Input validation with `RequestParser`, which collects all violations;
  the money format remains the responsibility of `Money`.
- A global filter translates any error, consistently across all endpoints:

| Situation            | Status              | `error.code`                                              |
| ------------------- | ------------------- | --------------------------------------------------------- |
| Invalid input    | 400                 | `VALIDATION_ERROR` (with `details`), `INVALID_AMOUNT`, ... |
| Resource not found | 404                 | `WALLET_NOT_FOUND`                                        |
| Conflict            | 409                 | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`         |
| Business rule    | 422                 | the `failureCode`                                         |
| Transient failure   | 503 + `Retry-After` | `TEMPORARILY_UNAVAILABLE`                                 |
| Bug                 | 500                 | `INTERNAL_ERROR`, no details                              |

- Ledger paginated by opaque cursor (`base64url` of `{"v": walletVersion}`),
  fetching `limit + 1` to know whether there's a next page.

**Consequences.** Step 11 only adds codes to the filter's table.

### ADR-010 — Concurrency: pessimistic per-wallet lock

**Status:** Accepted

**Decision.** `SELECT ... FOR UPDATE` on the wallet at the start of the transaction, in `READ COMMITTED`,
with a `lock_timeout` of 2 s. All reads involved in the decision (idempotency, reference,
reversal already done, balance) happen with the wallet locked. `UPDATE ... WHERE version = ?`
remains as defense in depth.

**Why not optimistic.** Contention on the same wallet is the normal case (provider retries,
BET and WIN of the same round, 50 identical requests). Optimistic locking would generate retry
storms, require a retry-count limit that turns into an error under legitimate load, and the
`version` (which only changes with the balance) wouldn't protect decisions with no movement, such as
rejections and PENDING_REFERENCE.

**Why it's safe.** One wallet per transaction: no deadlock. Short transaction with no network I/O.
Row-level lock, never global: different wallets run in parallel.

**Limit.** Serializes each wallet: a few hundred operations per second per wallet.

### ADR-011 — Idempotency

**Status:** Accepted

**Decision.**

1. Fast path without lock: existing key → replay (same hash) or 409 (different hash).
2. Under the lock: re-check the key (whoever waited on the lock may have lost the race).
3. Race between different wallets with the same key: `UNIQUE (idempotency_key)` decides;
   the loser re-reads and responds replay or 409.
4. Every decision is persisted, including REJECTED and PENDING_REFERENCE, with the observed balance:
   the replay returns the original response, with the balance at the time.

**Recommended key format.** The server accepts any string (up to 255 chars) as the
Idempotency-Key — it imposes no format. The recommended default for the provider is
`"{providerId}:{externalTransactionId}"`, which is what this repository's test clients
use (`test/support/wagering-client.ts`); there is no format validation because the key is
opaque to the server — only its uniqueness matters.

**payloadHash.** SHA-256 (hex) of RFC 8785 canonical JSON over: providerId,
externalTransactionId, playerId, walletId, roundId, gameId, kind, money (amount with 2 decimal places,
currency) and referenceExternalTransactionId (empty = absent). Excluded: the
Idempotency-Key header, correlationId, messageId and any transport metadata.

**Interpretations.**

- WALLET_NOT_FOUND responds 404 and is not persisted (there's no wallet for the FK nor for the lock).
- WALLET_PLAYER_MISMATCH is persisted, but the response doesn't carry the other player's wallet balance.
- The same (providerId, externalTransactionId) with a different key responds 409 DUPLICATE_TRANSACTION.

### ADR-012 — Multiple instances with no in-memory state

**Status:** Accepted

**Decision.**

- The application keeps no business state in memory: idempotency, lock and balance live in
  PostgreSQL. Any instance can serve any request, including the replay of an
  operation processed by another instance.
- "Multiple instances" here means several `bun src/main.ts` processes pointing at the same
  `DATABASE_URL`, each on its own port — there's no Dockerfile, image or orchestration (nginx,
  `docker compose`) for the application in this repository; the existing `docker-compose.yaml`
  only brings up PostgreSQL and LocalStack.
- With no load balancer, there's no automatic resend between instances: resending to another instance
  on failure is the client's decision, protected by the Idempotency-Key.

**Verification.** `test/concurrency/multi-instance.test.ts` and `test/resilience/restart-consistency.test.ts`
bring up three separate `bun src/main.ts` processes (each with its own pool), via
`test/support/app-process.ts`, over the same isolated database, and repeat the races distributing
the requests in round-robin: 100/80/80, the same bet 60 times, 30 bets contending for the balance,
simultaneous REFUNDs, simultaneous creation of the same wallet, independent wallets and replay by an
instance different from the one that processed it.

**Consequences.** Scaling the API means bringing up more processes. The limit becomes the primary
PostgreSQL and, per wallet, the row lock (ADR-010). Packaging into an image and deployment
orchestration (Docker, load balancer) remain out of the implemented scope.

### ADR-013 — SQS consumer: transactional inbox, ack after commit and error classification

**Status:** Accepted

**Decision.**

- The consumer reuses the API's `ProcessWagerTransactionUseCase`. The message is recorded
  in the inbox (`INSERT ... ON CONFLICT DO NOTHING` on `(consumer_name, message_id)`) within the
  SAME transaction as the financial effect, before the wallet lock. With the inbox, the idempotency
  fast path is skipped: the replay also records the message, in the main transaction.
- `WagerMessageHandler` decides; `SqsPollingConsumer` executes:

| Outcome                                                                                        | Decision     | Execution                                                 |
| ----------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| PROCESSED, REJECTED, PENDING_REFERENCE                                                          | ack         | `DeleteMessage` after the handler (i.e., after the COMMIT)     |
| Redelivery already seen (same messageId and content)                                                 | ack         | `DeleteMessage`                                          |
| Invalid message, `DomainError` (400/404/409 on the API), reused messageId with different content | dead-letter | `SendMessage` to the DLQ with reason + `DeleteMessage`         |
| Transient failure or unexpected error                                                            | retry       | `ChangeMessageVisibility` with backoff (1 s, 2 s... 60 s) |
| Retry on the `maxReceiveCount` attempt                                                            | dead-letter | `RETRIES_EXHAUSTED`, with the last error                  |

- Messages with the same `MessageGroupId` (= walletId) are processed in sequence; groups in parallel.
  A retry returns the following messages of the same group, preserving order.
- The DLQ receives the original body and the attributes `dlq-reason`, `dlq-detail`,
  `original-message-id` and `receive-count`. The queue's redrive policy is the safety net.
- Enabled on every instance that has SQS configured (with no configuration, it stays idle). Stops on
  `beforeApplicationShutdown`, before the database pool closes: finishes messages in
  flight (up to 20 s) and returns unstarted ones with visibility 0.

**Why a DomainError goes to the DLQ and not the ack.** On the API, these errors go back to
the provider as 400/404/409. On the queue there's no response: an ack would silently discard
the message; the DLQ preserves it for investigation.

**Verification.**

- Handler (database only): deduplication, simultaneous redeliveries, classification, inbox rolled back
  together with the effect on a transient failure.
- End-to-end (real queue, per-suite exclusive queues): processing, duplicate, rejection,
  order per group, immediate DLQ, retry with recovery, instance with no SQS configured.
- Resilience (real processes): SIGKILL between commit and ack (deterministic fault-injection
  point via `FAULT_INJECTION`), SIGTERM with a message in flight, exhaustion of
  attempts.

### ADR-014 — Transactional outbox with lease-based relay

**Status:** Accepted

**Decision.**

- The use case writes events to the outbox within the SAME transaction as the financial effect;
  nothing is published before the commit, because the relay is the publisher, reading what has already been confirmed.
- Each relay round: (1) reserves a batch with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, writing a lease (`locked_until`, `locked_by`); (2) publishes outside of a
  transaction; (3) marks the published ones and reschedules the failed ones, in a short transaction.
- Publication on `wallet-events.fifo` with `SendMessageBatch`: `MessageGroupId` = aggregateId
  (order per wallet), `MessageDeduplicationId` = eventId, body = the saved envelope.
- Publish failure: backoff from 1 s up to 5 min, with no attempt limit (a confirmed event cannot
  be lost). Broker down: the entire batch enters backoff.
- Worker enabled on every instance that has a publisher configured; stops on
  `beforeApplicationShutdown`.

**Why a lease and not a transaction lock during publishing.** Holding a transaction open
during network I/O would tie up a pool connection for the duration of the broker call. The lease
is written to the row and is valid without an open connection; if the relay dies, the lease
expires and another one takes over.

**Delivery guarantee: at-least-once.** Publishing to the broker and marking it in the database cannot be
atomic. If the relay dies between the two, the event is published again, with the same eventId.
SQS FIFO discards the duplicate within 5 minutes (an optimization); the guarantee is that the consumer
deduplicates by eventId.

**Limitations.**

- Different relays may publish events of the same wallet out of order; events carry
  `walletVersion` so the consumer can order them and discard stale ones.
- The lease uses each instance's own clock; a clock drift larger than the lease (30 s)
  could cause duplicate publication, which is already tolerated.

**Verification.**

- Logic (real database, in-memory publisher): order, 4 relays and 200 events with no duplicates,
  lease, relay dying before and after publishing, partial failure, broker down.
- End-to-end (real queue): a bet turns into events on `wallet-events.fifo`; body identical
  to what was saved; instance with no publisher configured doesn't publish.
- Resilience (real processes): the spec's scenario (commit confirmed, relay dies before
  publishing, another instance takes over and publishes), relay dying after publishing
  (safe republication) and 3 relays in separate processes with no loss.

### ADR-015 — Out-of-order references: backoff wait, shortcut and scheduler

**Status:** Accepted

**Decision.**

- A transaction whose reference doesn't exist (or exists but isn't terminal yet) becomes
  `PENDING_REFERENCE`: nothing is moved, the `WagerTransactionPendingReference` event
  is emitted, and the HTTP response is 202.
- New attempts with exponential backoff (1 s, 2 s, 4 s... up to 60 s, equal jitter) until the
  15-minute TTL; after that, `REJECTED` with `REFERENCE_NOT_FOUND` and
  `WagerTransactionRejected`. All configurable via environment variable.
- Shortcut: when a transaction reaches a final state, the pending transactions waiting on it
  are moved up to "now", within the same SQL transaction. Works in a chain (a resolved REFUND
  moves up the ROLLBACK waiting on it).
- Resolution uses the same decision logic as the first attempt (`WagerSettlement`): wallet lock,
  re-read under the lock (in a transaction separate from the first read, to avoid reading the identity
  map), reference policy, balance, movement and events, within the same SQL transaction.
- The scheduler is enabled on every instance, always: it reserves batches of overdue pending items with
  `FOR UPDATE SKIP LOCKED`, using `next_attempt_at` as the lease (10 s), and resolves them
  in parallel. Pending items of the same wallet are serialized by the wallet lock.

**Why wait on a pending reference instead of rejecting.** A ROLLBACK of a REFUND
that's still waiting on the BET has nothing wrong with it: it just arrived too early. Rejecting would punish
the provider for a delivery order it doesn't control. A REJECTED reference, on the other hand,
will never change, and keeps leading to `REFERENCE_NOT_PROCESSED`.

**Rescheduling generates no event.** Only entering the wait state and the final outcome are business
facts. Replaying the original request shows the current state: 202 while pending, the
outcome afterward.

**Verification.**

- Use case (real application, short time windows): rescheduling, shortcut, resolution, policy
  on resolution, expiration, chain, simultaneous resolutions (found the identity-map bug,
  blocked by the `fn_wtx_guard` trigger), concurrent reservations.
- End-to-end: REFUND ahead of the BET via the API and ROLLBACK ahead of the WIN via the queue, resolved
  with no manual call; automatic expiration.
- Resilience (real processes): scheduler dying after reserving; 3 schedulers and 30
  pending items, each resolved exactly once.

### ADR-016 — Read-only reconciliation

**Status:** Accepted

**Decision.**

- `POST /wallets/:id/reconciliation` (one wallet) and `bun run reconcile` (all, in pages
  by keyset) compare the stored balance with the balance reconstructed from the ledger.
- Five checks: `BALANCE_MISMATCH` (the spec's requirement), `LAST_ENTRY_MISMATCH`,
  `VERSION_MISMATCH`, `LEDGER_CHAIN_BROKEN`, `LEDGER_VERSION_GAP`.
- Each query is a single SQL command (CTEs + window functions): a single snapshot at
  READ COMMITTED, with no false divergences under concurrent load.
- Values normalized with `round(x, 2)::text`: the `money_amount` domain accepts up to 2 decimal places,
  and a value written by hand as `81` must not diverge from `81.00` merely due to formatting.
- Read-only by construction: neither the use case nor the repository port has a write path.
- Every check becomes a metric (`wallet_reconciliation_checks_total`); every divergence becomes a
  structured error log (`WALLET_LEDGER_DIVERGENCE`) and increments
  `wallet_reconciliation_divergences_total{code}`.
- A divergence responds 200 with `consistent: false` (a finding, not a request error).
  The command exits with code 1, for cron and alerts.

**Why never auto-correct.** A divergence means something bypassed
domain, version, triggers and permissions. Fixing the balance would erase the evidence of the cause and
could mask fraud. The correction, when necessary, is a human decision, made with
an auditable adjustment entry, never with an UPDATE on the balance.

**Verification.** Real corruptions made by the owner with the triggers disabled (balance
altered, an entry deleted from the middle, version advanced), scans in small pages,
continuous reconciliation during 60 concurrent bets with no false divergence, and the command
run as a process, with the exit codes.

### ADR-017 — Observability: structured logs, Prometheus metrics and health checks

**Status:** Accepted

**Decision.**

- **Logs** (`src/platform/observability/json-logger.ts`, `log-context.ts`): structured JSON,
  `correlationId`/`requestId`/`messageId`/`transactionId`/`walletId`/`providerId` propagated
  via `AsyncLocalStorage` (`runWithLogContext`/`enrichLogContext`) — never need to be
  passed manually down a call chain. Never logs the full financial payload (only ids and metadata).
- **Metrics** (`src/platform/observability/metrics.ts`): in-memory registry with the three
  Prometheus types — counter (`increment`), gauge (`set`) and a true histogram (`observe`,
  the Prometheus client's default cumulative buckets: 5ms .. 10s). Exposed at `GET /metrics`
  (`metrics.controller.ts` + `prometheus-format.ts`, plain text, no authentication — same as
  `/health`), with no external library.
  - `wagering_transactions_total{status}`, `wagering_duplicates_detected_total{source}` —
    `ProcessWagerTransactionUseCase.execute()` (idempotency) and `WagerMessageHandler.classify()`
    (inbox redelivery).
  - `sqs_message_retries_total`, `sqs_dead_letter_messages_total{reason}`,
    `sqs_message_processing_duration_seconds` — `SqsPollingConsumer` (generic, not specific
    to wagering).
  - `database_lock_conflicts_total{sql_state}` — new `isLockConflict()` in `pg-error.ts`
    (a subset of `isTransientDatabaseError`: only `lock_timeout`/`deadlock`), checked in the
    `ErrorMappingFilter` (HTTP) and in `WagerMessageHandler` (SQS).
  - `outbox_publish_lag_seconds` — `OutboxRelay.relayOnce()`, the largest lag in the published batch.
  - `http_request_duration_seconds{method,route,status}` — `HttpMetricsInterceptor`, via a
    global `APP_INTERCEPTOR`: covers the entire API at once, without instrumenting each controller.
- **Health checks** (`src/platform/health/health.controller.ts`), separated as the spec
  requires: `/health/live` never checks a dependency (process alive); `/health/ready` checks
  Postgres (`MikroORM.isConnected()`) and SQS (`GetQueueUrlCommand`) in parallel, 503 if
  either fails. An instance with no SQS configured reports SQS as `"skipped"`, not as a
  failure — today every real instance has SQS configured (`sqsConfigFromEnv()` is always called in
  `main.ts`), so in practice `/health/ready` always checks both for real.

**Test coverage per metric.** All 8 metrics have their own value asserted by a test,
not just the behavior they measure:
`test/integration/observability/metrics.test.ts` covers the format (`# TYPE`, cumulative buckets
up to `+Inf`, `_sum`, `_count`) and `wagering_transactions_total`,
`wagering_duplicates_detected_total{source=idempotency_key}` and `http_request_duration_seconds`
after real traffic; `wager-message-handler.test.ts` covers
`wagering_duplicates_detected_total{source=inbox_message}` and `database_lock_conflicts_total`
(real lock_timeout); `sqs-consumer.test.ts` covers `sqs_message_retries_total`,
`sqs_dead_letter_messages_total` and `sqs_message_processing_duration_seconds` through the real
loop of `SqsPollingConsumer` (LocalStack); `outbox-relay.test.ts` covers
`outbox_publish_lag_seconds`.

**Consequences.** `/metrics` and `/health/`* remain always open (no guard), as the spec
requires. OpenTelemetry and a dashboard remain optional, not implemented.
