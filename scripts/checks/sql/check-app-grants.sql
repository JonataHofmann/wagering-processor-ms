\set VERBOSITY verbose

\echo '--- quem sou eu: espera wagering_app'
SELECT current_user;

BEGIN;

\echo '--- 1) ler wallets: deve PASSAR'
SAVEPOINT s1;
SELECT count(*) FROM wallets;
ROLLBACK TO SAVEPOINT s1;

\echo '--- 2) criar wallet sem saldo: deve PASSAR'
SAVEPOINT s2;
INSERT INTO wallets (id, player_id, currency, balance, version)
VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', '0.00', 1);
ROLLBACK TO SAVEPOINT s2;

\echo '--- 3) alterar ledger: espera 42501'
SAVEPOINT s3;
UPDATE wallet_ledger_entries SET amount = '1.00';
ROLLBACK TO SAVEPOINT s3;

\echo '--- 4) apagar ledger: espera 42501'
SAVEPOINT s4;
DELETE FROM wallet_ledger_entries;
ROLLBACK TO SAVEPOINT s4;

\echo '--- 5) truncate no ledger: espera 42501'
SAVEPOINT s5;
TRUNCATE wallet_ledger_entries;
ROLLBACK TO SAVEPOINT s5;

\echo '--- 6) apagar wallets: espera 42501'
SAVEPOINT s6;
DELETE FROM wallets;
ROLLBACK TO SAVEPOINT s6;

\echo '--- 7) apagar transações: espera 42501'
SAVEPOINT s7;
DELETE FROM wager_transactions;
ROLLBACK TO SAVEPOINT s7;

\echo '--- 8) apagar da outbox: deve PASSAR'
SAVEPOINT s8;
DELETE FROM outbox_messages WHERE published_at IS NOT NULL;
ROLLBACK TO SAVEPOINT s8;

\echo '--- 9) criar tabela: espera 42501'
SAVEPOINT s9;
CREATE TABLE intrusa (id int);
ROLLBACK TO SAVEPOINT s9;

\echo '--- 10) apagar tabela: espera 42501'
SAVEPOINT s10;
DROP TABLE wallets;
ROLLBACK TO SAVEPOINT s10;

\echo '--- 11) ler tabela de migrations: espera 42501'
SAVEPOINT s11;
SELECT count(*) FROM mikro_orm_migrations;
ROLLBACK TO SAVEPOINT s11;

ROLLBACK;
\echo '--- fim'