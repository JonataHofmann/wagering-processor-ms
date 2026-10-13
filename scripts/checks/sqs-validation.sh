PLAYER=$(uuidgen | tr 'A-Z' 'a-z')
WALLET=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

EXT=$(uuidgen)
cat > /tmp/msg.json <<EOF
{"messageId":"msg-$EXT","type":"WagerTransactionRequested","occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "data":{"providerId":"provider-a","externalTransactionId":"$EXT","idempotencyKey":"provider-a:$EXT",
 "playerId":"$PLAYER","walletId":"$WALLET","roundId":"round-987","gameId":"fortune-chimp",
 "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}
EOF

QUEUE_URL=$(docker compose exec -T localstack awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
docker compose exec -T localstack awslocal sqs send-message --queue-url "$QUEUE_URL" \
  --message-group-id "$WALLET" --message-deduplication-id "$EXT" \
  --message-body "$(cat /tmp/msg.json)"

sleep 2
curl -s localhost:3000/wallets/$WALLET; echo
curl -s localhost:3000/providers/provider-a/wagering/transactions/$EXT; echo