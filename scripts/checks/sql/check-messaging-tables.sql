\set VERBOSITY terse

-- ================= preparação =================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
VALUES ('wager-transactions', 'msg-123', repeat('a', 64));

INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
VALUES (gen_random_uuid(), gen_random_uuid(), 'WalletBalanceChanged', 1, '{"ok": true}', now());

\echo '--- preparação ok'

-- ================= verificações =================
\set ON_ERROR_STOP off

\echo '--- 1) mesma mensagem, mesmo consumidor: espera 23505'
SAVEPOINT s1;
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
VALUES ('wager-transactions', 'msg-123', repeat('a', 64));
ROLLBACK TO SAVEPOINT s1;

\echo '--- 2) mesma mensagem, outro consumidor: deve PASSAR'
SAVEPOINT s2;
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
VALUES ('audit', 'msg-123', repeat('a', 64));
ROLLBACK TO SAVEPOINT s2;

\echo '--- 3) ON CONFLICT DO NOTHING em duplicata: espera 0 linhas (é assim que o consumer detecta)'
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
VALUES ('wager-transactions', 'msg-123', repeat('a', 64))
ON CONFLICT DO NOTHING
RETURNING message_id;

\echo '--- 4) payload_hash inválido: espera 23514'
SAVEPOINT s4;
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
VALUES ('wager-transactions', 'msg-999', 'nao-e-hash');
ROLLBACK TO SAVEPOINT s4;

\echo '--- 5) outbox com attempts negativo: espera 23514'
SAVEPOINT s5;
INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts)
VALUES (gen_random_uuid(), gen_random_uuid(), 'X', 1, '{}', now(), -1);
ROLLBACK TO SAVEPOINT s5;

\echo '--- 6) outbox com event_version 0: espera 23514'
SAVEPOINT s6;
INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at)
VALUES (gen_random_uuid(), gen_random_uuid(), 'X', 0, '{}', now());
ROLLBACK TO SAVEPOINT s6;

\echo '--- 7) evento novo já está vencido para o relay: espera 1 linha'
SELECT event_type, attempts, next_attempt_at <= now() AS pronto_para_publicar
  FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= now();

ROLLBACK;
\echo '--- fim: tudo desfeito'