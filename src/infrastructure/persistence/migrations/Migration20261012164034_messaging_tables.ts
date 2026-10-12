import { Migration } from '@mikro-orm/migrations';

export class Migration20261012164034_messaging_tables extends Migration {
  override name = 'Migration20261012164034_messaging_tables';

  override up(): void | Promise<void> {
    // =====================================================================
    // INBOX: deduplicação persistente das mensagens recebidas do SQS
    // =====================================================================
    this.addSql(`
    CREATE TABLE inbox_messages (
      consumer_name  varchar(100) NOT NULL,
      message_id     varchar(128) NOT NULL,
      payload_hash   char(64)     NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      received_at    timestamptz  NOT NULL DEFAULT now(),
      processed_at   timestamptz,
      PRIMARY KEY (consumer_name, message_id)
    )`);

    // =====================================================================
    // OUTBOX: eventos gravados junto com o efeito financeiro, publicados depois
    // =====================================================================
    this.addSql(`
    CREATE TABLE outbox_messages (
      id               uuid         PRIMARY KEY,
      aggregate_id     uuid         NOT NULL,
      event_type       varchar(100) NOT NULL,
      event_version    integer      NOT NULL CHECK (event_version >= 1),
      payload          jsonb        NOT NULL,
      occurred_at      timestamptz  NOT NULL,
      attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
      locked_until     timestamptz,
      locked_by        varchar(100),
      published_at     timestamptz,
      last_error       varchar(500)
    )`);

    // fila de trabalho do relay: só o que ainda não foi publicado
    this.addSql(`
    CREATE INDEX ix_outbox_due
      ON outbox_messages (next_attempt_at)
      WHERE published_at IS NULL`);

    // métrica de lag: o evento pendente mais antigo
    this.addSql(`
    CREATE INDEX ix_outbox_pending_occurred
      ON outbox_messages (occurred_at)
      WHERE published_at IS NULL`);
  }

  override down(): void | Promise<void> {
      this.addSql(`DROP TABLE outbox_messages`);
      this.addSql(`DROP TABLE inbox_messages`);
  }
}
