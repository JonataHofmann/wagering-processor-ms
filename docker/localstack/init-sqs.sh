#!/bin/bash
set -euo pipefail

echo "Creating SQS queues..."

# 1) DLQ primeiro: precisamos do ARN dela para a redrive policy
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_URL=$(awslocal sqs get-queue-url \
  --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# 2) Fila principal: após 5 recebimentos sem ack, a mensagem vai para a DLQ
cat > /tmp/wager-transactions.json <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "ReceiveMessageWaitTimeSeconds": "20",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
}
EOF
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions.json

# 3) Destino dos eventos publicados pela outbox.
#    Criada por último: o healthcheck usa a existência dela como sinal de "pronto".
awslocal sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready"