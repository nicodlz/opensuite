#!/bin/sh
# Development-only S3 and SQS substitutes.
set -eu
bucket="${INBOUND_BUCKET:-opensuite-inbound}"
queue="${INBOUND_QUEUE:-opensuite-inbound}"
awslocal s3api create-bucket --bucket "$bucket" >/dev/null
awslocal s3api create-bucket --bucket "${ARCHIVE_BUCKET:-opensuite-archive}" >/dev/null
dlq_url="$(awslocal sqs create-queue --queue-name "$queue-dlq" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)"
queue_url="$(awslocal sqs create-queue --queue-name "$queue" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)"
awslocal sqs set-queue-attributes --queue-url "$queue_url" --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"5\"}" >/dev/null
echo "opensuite: local S3 buckets and SQS queues ready"
