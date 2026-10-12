docker compose exec postgres psql -U wagering_owner -d wagering -c "
SELECT t.table_name,
       has_table_privilege('wagering_app', t.table_name, 'SELECT')   AS sel,
       has_table_privilege('wagering_app', t.table_name, 'INSERT')   AS ins,
       has_table_privilege('wagering_app', t.table_name, 'UPDATE')   AS upd,
       has_table_privilege('wagering_app', t.table_name, 'DELETE')   AS del,
       has_table_privilege('wagering_app', t.table_name, 'TRUNCATE') AS trunc
FROM information_schema.tables t
WHERE t.table_schema = 'public'
ORDER BY 1;"

Esperado:

      table_name       | sel | ins | upd | del | trunc
-----------------------+-----+-----+-----+-----+-------
 inbox_messages        | t   | t   | t   | f   | f
 mikro_orm_migrations  | f   | f   | f   | f   | f
 outbox_messages       | t   | t   | t   | t   | f
 wager_transactions    | t   | t   | t   | f   | f
 wallet_ledger_entries | t   | t   | f   | f   | f
 wallets               | t   | t   | t   | f   | f



 docker compose exec -T postgres \
  psql "postgres://wagering_app:app@localhost:5432/wagering" < scripts/checks/sql/check-app-grants.sql