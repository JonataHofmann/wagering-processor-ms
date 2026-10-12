docker compose exec postgres psql -U wagering_owner -d wagering -c \
"INSERT INTO wallets (id, player_id, currency, balance, version)
 VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', '-1.00', 1)"
#Esperado: ERROR: value for domain money_amount violates check constraint "money_amount_check".


#Três casas decimais
docker compose exec postgres psql -U wagering_owner -d wagering -c \
"INSERT INTO wallets (id, player_id, currency, balance, version)
 VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', '10.005', 1)"
# Esperado: o mesmo erro do domain. O valor não vira 10.01.


# moeda invalida
 docker compose exec postgres psql -U wagering_owner -d wagering -c \
"INSERT INTO wallets (id, player_id, currency, balance, version)
 VALUES (gen_random_uuid(), gen_random_uuid(), 'brl', '10.00', 1)"
 #Esperado: ERROR: value for domain currency_code violates check constraint.


# Wallet duplicada para o mesmo jogador e moeda
 docker compose exec -T postgres psql -U wagering_owner -d wagering <<'SQL'
BEGIN;
INSERT INTO wallets (id, player_id, currency, balance, version)
VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'BRL', '0.00', 1);
INSERT INTO wallets (id, player_id, currency, balance, version)
VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'BRL', '0.00', 1);
ROLLBACK;
SQL
# Esperado: o primeiro INSERT passa e o segundo falha com duplicate key value violates unique constraint "uq_wallets_player_currency".