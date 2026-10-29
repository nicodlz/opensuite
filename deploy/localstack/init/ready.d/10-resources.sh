#!/bin/sh
# Development-only AWS substitutes: the inbound mail bucket and its queues.
set -eu
awslocal s3api create-bucket --bucket "${INBOUND_BUCKET:-opensuite-inbound}" >/dev/null
awslocal sqs create-queue --queue-name "${INBOUND_QUEUE:-opensuite-inbound}-dlq" >/dev/null
awslocal sqs create-queue --queue-name "${INBOUND_QUEUE:-opensuite-inbound}" >/dev/null
echo "opensuite: local S3 bucket and SQS queues ready"
