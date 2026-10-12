import { Migration } from '@mikro-orm/migrations';

export class Migration20261012153252_financial_tables extends Migration {
  override name = 'Migration20261012153252_financial_tables';

  override up(): void | Promise<void> {
    this.addSql(`
    CREATE DOMAIN money_amount AS numeric
      CHECK (VALUE >= 0 AND scale(VALUE) <= 2 AND VALUE < 1000000000000000000)`);

    this.addSql(`
    CREATE DOMAIN currency_code AS char(3)
      CHECK (VALUE ~ '^[A-Z]{3}$')`);

    // ---------- wallets ----------
    this.addSql(`
    CREATE TABLE wallets (
      id          uuid          PRIMARY KEY,
      player_id   uuid          NOT NULL,
      currency    currency_code NOT NULL,
      balance     money_amount  NOT NULL,
      version     integer       NOT NULL CHECK (version >= 1),
      created_at  timestamptz   NOT NULL DEFAULT now(),
      updated_at  timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
      CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)
    )`);

    // ---------- wager_transactions ----------
    this.addSql(`
    CREATE TABLE wager_transactions (
      id                                 uuid          PRIMARY KEY,
      provider_id                        varchar(64)   NOT NULL,
      external_transaction_id            varchar(128)  NOT NULL,
      idempotency_key                    varchar(255)  NOT NULL,
      payload_hash                       char(64)      NOT NULL,
      wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
      player_id                          uuid          NOT NULL,
      round_id                           varchar(128)  NOT NULL,
      game_id                            varchar(128)  NOT NULL,
      kind                               varchar(16)   NOT NULL
        CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      amount                             money_amount  NOT NULL CHECK (amount > 0),
      currency                           currency_code NOT NULL,
      reference_external_transaction_id  varchar(128),
      reference_transaction_id           uuid          REFERENCES wager_transactions (id),
      status                             varchar(24)   NOT NULL
        CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      failure_code                       varchar(64),
      balance_snapshot                   money_amount,
      attempts                           integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at                    timestamptz,
      expires_at                         timestamptz,
      created_at                         timestamptz   NOT NULL DEFAULT now(),
      updated_at                         timestamptz   NOT NULL DEFAULT now(),
      processed_at                       timestamptz,

      CONSTRAINT uq_wtx_idempotency_key   UNIQUE (idempotency_key),
      CONSTRAINT uq_wtx_provider_external UNIQUE (provider_id, external_transaction_id),

      CONSTRAINT ck_wtx_reference_by_kind CHECK (
        CASE kind
          WHEN 'REFUND'   THEN reference_external_transaction_id IS NOT NULL
          WHEN 'ROLLBACK' THEN reference_external_transaction_id IS NOT NULL
          WHEN 'WIN'      THEN true
          ELSE reference_external_transaction_id IS NULL
        END),

      CONSTRAINT ck_wtx_processed_reference CHECK (
        status <> 'PROCESSED'
        OR reference_external_transaction_id IS NULL
        OR reference_transaction_id IS NOT NULL),

      CONSTRAINT ck_wtx_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),

      CONSTRAINT ck_wtx_processed_at CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),

      CONSTRAINT ck_wtx_snapshot CHECK (status NOT IN ('PROCESSED','REJECTED') OR balance_snapshot IS NOT NULL),

      CONSTRAINT ck_wtx_pending_schedule CHECK (
        status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND expires_at IS NOT NULL)),

      CONSTRAINT ck_wtx_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'system'))
    )`);

    this.addSql(`
    CREATE UNIQUE INDEX uq_wtx_single_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);

    this.addSql(`
    CREATE INDEX ix_wtx_pending_due
      ON wager_transactions (next_attempt_at)
      WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`
    CREATE INDEX ix_wtx_pending_by_reference
      ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);

    // ---------- wallet_ledger_entries ----------
    this.addSql(`
    CREATE TABLE wallet_ledger_entries (
      id              uuid          PRIMARY KEY,
      wallet_id       uuid          NOT NULL,
      transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
      wallet_version  integer       NOT NULL CHECK (wallet_version >= 1),
      direction       varchar(6)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
      amount          money_amount  NOT NULL CHECK (amount > 0),
      currency        currency_code NOT NULL,
      balance_before  money_amount  NOT NULL,
      balance_after   money_amount  NOT NULL,
      created_at      timestamptz   NOT NULL DEFAULT now(),

      CONSTRAINT fk_ledger_wallet_currency
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),

      CONSTRAINT uq_ledger_transaction    UNIQUE (transaction_id),

      CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
      
      CONSTRAINT ck_ledger_arithmetic CHECK (
        (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
        (direction = 'DEBIT'  AND balance_after = balance_before - amount))
    )`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP TABLE wallets`);
    this.addSql(`DROP DOMAIN currency_code`);
    this.addSql(`DROP DOMAIN money_amount`);
  }
}
