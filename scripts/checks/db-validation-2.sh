# Wallet com saldo e sem lançamento.
docker compose exec -T postgres psql -U wagering_owner -d wagering <<'SQL'
\set VERBOSITY verbose
BEGIN;
INSERT INTO wallets (id, player_id, currency, balance, version)
VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', '10.00', 1);
COMMIT;
SQL
#Esperado: o INSERT passa e o COMMIT falha com ERROR: WL002: wallet ... opened with balance 10.00 without OPENING entry. Nada fica gravado.




docker compose exec -T postgres psql -U wagering_owner -d wagering < scripts/checks/sql/check-integrity-triggers.sql
/*
--- 0) abertura correta: deve PASSAR
SET CONSTRAINTS
--- 1) alterar lançamento: espera WL001
ERROR:  WL001: wallet_ledger_entries is append-only (UPDATE blocked)
--- 2) apagar lançamento: espera WL001
ERROR:  WL001: wallet_ledger_entries is append-only (DELETE blocked)
--- 3) mudar saldo sem lançamento: espera WL002
ERROR:  WL002: wallet ... change to v2 has no matching ledger entry
--- 4) mudar estado terminal: espera WL003
ERROR:  WL003: transaction ... is terminal (PROCESSED)
--- 5) apagar transação: espera WL003
ERROR:  WL003: wager_transactions rows cannot be deleted
--- 6) trocar moeda da wallet: espera WL004
ERROR:  WL004: wallet ... immutable fields changed
ROLLBACK
*/