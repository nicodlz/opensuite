#!/bin/sh
# Development-only AWS substitutes: the inbound mail bucket and its queues.
set -eu
awslocal s3api create-bucket --bucket "${INBOUND_BUCKET:-opensuite-inbound}" >/dev/null
awslocal s3api create-bucket --bucket "${DRIVE_S3_BUCKET:-opensuite-drive}" >/dev/null
# Local development only. Production buckets need an origin-specific CORS policy.
awslocal s3api put-bucket-cors --bucket "${DRIVE_S3_BUCKET:-opensuite-drive}" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":300}]}' >/dev/null
awslocal sqs create-queue --queue-name "${INBOUND_QUEUE:-opensuite-inbound}-dlq" >/dev/null
awslocal sqs create-queue --queue-name "${INBOUND_QUEUE:-opensuite-inbound}" >/dev/null
echo "opensuite: local S3 bucket and SQS queues ready"
