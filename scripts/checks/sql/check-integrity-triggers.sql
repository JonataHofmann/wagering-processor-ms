\set VERBOSITY verbose

-- ids usados em todo o roteiro (definidos uma vez só)
\set wallet  '00000000-0000-0000-0000-0000000000a1'
\set player  '00000000-0000-0000-0000-0000000000b1'
\set opening '00000000-0000-0000-0000-0000000000c1'
\set entry   '00000000-0000-0000-0000-0000000000d1'

-- ================= preparação: qualquer erro aqui para o script =================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO wallets (id, player_id, currency, balance, version)
VALUES (:'wallet', :'player', 'BRL', '100.00', 1);

INSERT INTO wager_transactions
  (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
   wallet_id, player_id, round_id, game_id, kind, amount, currency,
   status, balance_snapshot, processed_at)
VALUES (:'opening', 'system', 'opening-a1', 'opening:a1', repeat('a', 64),
        :'wallet', :'player', 'opening', 'opening', 'OPENING', '100.00', 'BRL',
        'PROCESSED', '100.00', now());

INSERT INTO wallet_ledger_entries
  (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
   balance_before, balance_after)
VALUES (:'entry', :'wallet', :'opening', 1, 'CREDIT', '100.00', 'BRL', '0.00', '100.00');

\echo '--- 0) abertura correta: deve PASSAR'
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- ================= verificações: aqui os erros são esperados =================
\set ON_ERROR_STOP off

\echo '--- 1) alterar lançamento: espera WL001'
SAVEPOINT s1;
UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = :'entry';
ROLLBACK TO SAVEPOINT s1;

\echo '--- 2) apagar lançamento: espera WL001'
SAVEPOINT s2;
DELETE FROM wallet_ledger_entries WHERE id = :'entry';
ROLLBACK TO SAVEPOINT s2;

\echo '--- 3) mudar saldo sem lançamento: espera WL002'
SAVEPOINT s3;
UPDATE wallets SET balance = '50.00', version = 2 WHERE id = :'wallet';
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO SAVEPOINT s3;
SET CONSTRAINTS ALL DEFERRED;

\echo '--- 4) mudar estado terminal: espera WL003'
SAVEPOINT s4;
UPDATE wager_transactions
   SET status = 'REJECTED', failure_code = 'X', processed_at = NULL
 WHERE id = :'opening';
ROLLBACK TO SAVEPOINT s4;

\echo '--- 5) apagar transação: espera WL003'
SAVEPOINT s5;
DELETE FROM wager_transactions WHERE id = :'opening';
ROLLBACK TO SAVEPOINT s5;

\echo '--- 6) trocar moeda da wallet: espera WL004'
SAVEPOINT s6;
UPDATE wallets SET currency = 'USD' WHERE id = :'wallet';
ROLLBACK TO SAVEPOINT s6;

-- desfaz tudo: nenhum dado fica no banco
ROLLBACK;
\echo '--- fim: tudo desfeito'