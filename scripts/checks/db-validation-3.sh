docker compose exec -T postgres psql -U wagering_owner -d wagering < scripts/checks/sql/check-messaging-tables.sql

--- preparação ok
--- 1) mesma mensagem, mesmo consumidor: espera 23505
ERROR:  duplicate key value violates unique constraint "inbox_messages_pkey"
--- 2) mesma mensagem, outro consumidor: deve PASSAR
INSERT 0 1
--- 3) ON CONFLICT DO NOTHING em duplicata: espera 0 linhas
 message_id
------------
(0 rows)
--- 4) payload_hash inválido: espera 23514
ERROR:  new row for relation "inbox_messages" violates check constraint ...
--- 5) outbox com attempts negativo: espera 23514
ERROR:  new row for relation "outbox_messages" violates check constraint ...
--- 6) outbox com event_version 0: espera 23514
ERROR:  new row for relation "outbox_messages" violates check constraint ...
--- 7) evento novo já está vencido para o relay: espera 1 linha
      event_type      | attempts | pronto_para_publicar
----------------------+----------+----------------------
 WalletBalanceChanged |        0 | t
--- fim: tudo desfeito