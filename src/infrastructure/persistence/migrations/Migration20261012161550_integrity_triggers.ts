import { Migration } from '@mikro-orm/migrations';

export class Migration20261012161550_integrity_triggers extends Migration {
  override name = 'Migration20261012161550_integrity_triggers';

  override up(): void | Promise<void> {
    // =====================================================================
    // 1. LEDGER APPEND-ONLY (imediato)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
        USING ERRCODE = 'WL001';
    END $$`);

    this.addSql(`
    CREATE TRIGGER trg_ledger_no_update_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only()`);

    this.addSql(`
    CREATE TRIGGER trg_ledger_no_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_append_only()`);

    // =====================================================================
    // 2. WALLET: CAMPOS IMUTÁVEIS (imediato)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_wallet_immutable_fields() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
         OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'wallet % immutable fields changed', OLD.id USING ERRCODE = 'WL004';
      END IF;
      RETURN NEW;
    END $$`);

    this.addSql(`
    CREATE TRIGGER trg_wallets_immutable
      BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION fn_wallet_immutable_fields()`);

    // =====================================================================
    // 3. WALLET ⇒ LEDGER: toda mudança de saldo tem lançamento (no COMMIT)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_assert_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE e record;
    BEGIN
      -- abertura: version 1; se houver saldo, exige lançamento OPENING (CREDIT v1, 0 → saldo)
      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'wallet % must start at version 1', NEW.id USING ERRCODE = 'WL002';
        END IF;
        IF NEW.balance = 0 THEN
          RETURN NULL;
        END IF;
        SELECT direction, balance_before, balance_after INTO e
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id AND wallet_version = 1;
        IF NOT FOUND OR e.direction <> 'CREDIT'
           OR e.balance_before <> 0 OR e.balance_after <> NEW.balance THEN
          RAISE EXCEPTION 'wallet % opened with balance % without OPENING entry', NEW.id, NEW.balance
            USING ERRCODE = 'WL002';
        END IF;
        RETURN NULL;
      END IF;

      -- update sem mudar saldo nem versão (ex.: updated_at): nada a verificar
      IF NEW.balance = OLD.balance AND NEW.version = OLD.version THEN
        RETURN NULL;
      END IF;

      -- version sobe exatamente 1, e só quando o saldo muda
      IF NEW.version <> OLD.version + 1 OR NEW.balance = OLD.balance THEN
        RAISE EXCEPTION 'wallet % version must increment by 1 exactly when balance changes', NEW.id
          USING ERRCODE = 'WL002';
      END IF;

      -- precisa existir o lançamento desta versão, com antes/depois batendo
      SELECT balance_before, balance_after INTO e
        FROM wallet_ledger_entries
       WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
      IF NOT FOUND OR e.balance_before <> OLD.balance OR e.balance_after <> NEW.balance THEN
        RAISE EXCEPTION 'wallet % change to v% has no matching ledger entry', NEW.id, NEW.version
          USING ERRCODE = 'WL002';
      END IF;
      RETURN NULL;
    END $$`);

    this.addSql(`
    CREATE CONSTRAINT TRIGGER trg_wallets_ledger_consistency
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fn_assert_wallet_ledger()`);

    // =====================================================================
    // 4. LEDGER ⇒ TRANSAÇÃO: lançamento coerente com sua transação (no COMMIT)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_assert_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE t record; expected varchar(6); wallet_version_now integer;
    BEGIN
      SELECT status, kind, wallet_id, amount, currency, reference_transaction_id INTO t
        FROM wager_transactions WHERE id = NEW.transaction_id;

      -- só transação PROCESSED que move saldo gera lançamento, com mesmo valor/moeda/wallet
      IF t.status <> 'PROCESSED' OR t.kind = 'LOSS' OR t.wallet_id <> NEW.wallet_id
         OR t.amount <> NEW.amount OR t.currency <> NEW.currency THEN
        RAISE EXCEPTION 'ledger entry % does not match transaction %', NEW.id, NEW.transaction_id
          USING ERRCODE = 'WL002';
      END IF;

      -- direção correta: BET debita; ROLLBACK inverte a referência; o resto credita
      expected := CASE t.kind
        WHEN 'BET' THEN 'DEBIT'
        WHEN 'ROLLBACK' THEN (
          SELECT CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END
            FROM wallet_ledger_entries WHERE transaction_id = t.reference_transaction_id)
        ELSE 'CREDIT'
      END;
      IF expected IS NULL OR NEW.direction <> expected THEN
        RAISE EXCEPTION 'ledger entry % has direction %, expected %', NEW.id, NEW.direction, expected
          USING ERRCODE = 'WL002';
      END IF;

      -- lançamento não pode estar "à frente" da versão da wallet
      SELECT version INTO wallet_version_now FROM wallets WHERE id = NEW.wallet_id;
      IF wallet_version_now < NEW.wallet_version THEN
        RAISE EXCEPTION 'ledger entry % ahead of wallet version', NEW.id USING ERRCODE = 'WL002';
      END IF;
      RETURN NULL;
    END $$`);

    this.addSql(`
    CREATE CONSTRAINT TRIGGER trg_ledger_transaction_consistency
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fn_assert_ledger_transaction()`);

    // =====================================================================
    // 5. TRANSAÇÃO ⇒ LEDGER: PROCESSED que move saldo tem lançamento (no COMMIT)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_assert_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE cur record; has_entry boolean;
    BEGIN
      -- lê o estado ATUAL da linha, não o do momento do evento
      SELECT status, kind INTO cur FROM wager_transactions WHERE id = NEW.id;
      SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id) INTO has_entry;

      IF cur.status = 'PROCESSED' AND cur.kind <> 'LOSS' AND NOT has_entry THEN
        RAISE EXCEPTION 'transaction % processed without ledger entry', NEW.id USING ERRCODE = 'WL002';
      END IF;
      IF (cur.status <> 'PROCESSED' OR cur.kind = 'LOSS') AND has_entry THEN
        RAISE EXCEPTION 'transaction % (% %) must not have ledger entry', NEW.id, cur.kind, cur.status
          USING ERRCODE = 'WL002';
      END IF;
      RETURN NULL;
    END $$`);

    this.addSql(`
    CREATE CONSTRAINT TRIGGER trg_wtx_ledger_consistency
      AFTER INSERT OR UPDATE OF status ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fn_assert_transaction_ledger()`);

    // =====================================================================
    // 6. TRANSAÇÃO: ESTADOS TERMINAIS E COLUNAS IMUTÁVEIS (imediato)
    // =====================================================================
    this.addSql(`
    CREATE FUNCTION fn_wtx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'WL003';
      END IF;
      IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'WL003';
      END IF;
      IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
        RAISE EXCEPTION 'transaction % cannot go back to PENDING', OLD.id USING ERRCODE = 'WL003';
      END IF;
      IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
             NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
             NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id,
             NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
             OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
             OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id,
             OLD.created_at) THEN
        RAISE EXCEPTION 'transaction % immutable columns changed', OLD.id USING ERRCODE = 'WL003';
      END IF;
      RETURN NEW;
    END $$`);

    this.addSql(`
    CREATE TRIGGER trg_wtx_guard
      BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION fn_wtx_guard()`);
  }

  override down(): void | Promise<void> {
    // trigger antes da função: a função não pode ser removida enquanto um trigger a usa
    this.addSql(`DROP TRIGGER trg_wtx_guard ON wager_transactions`);
    this.addSql(`DROP FUNCTION fn_wtx_guard()`);

    this.addSql(
      `DROP TRIGGER trg_wtx_ledger_consistency ON wager_transactions`,
    );
    this.addSql(`DROP FUNCTION fn_assert_transaction_ledger()`);

    this.addSql(
      `DROP TRIGGER trg_ledger_transaction_consistency ON wallet_ledger_entries`,
    );
    this.addSql(`DROP FUNCTION fn_assert_ledger_transaction()`);

    this.addSql(`DROP TRIGGER trg_wallets_ledger_consistency ON wallets`);
    this.addSql(`DROP FUNCTION fn_assert_wallet_ledger()`);

    this.addSql(`DROP TRIGGER trg_wallets_immutable ON wallets`);
    this.addSql(`DROP FUNCTION fn_wallet_immutable_fields()`);

    this.addSql(`DROP TRIGGER trg_ledger_no_truncate ON wallet_ledger_entries`);
    this.addSql(
      `DROP TRIGGER trg_ledger_no_update_delete ON wallet_ledger_entries`,
    );
    this.addSql(`DROP FUNCTION fn_ledger_append_only()`);
  }
}
