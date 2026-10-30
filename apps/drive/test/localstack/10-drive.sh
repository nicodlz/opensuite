#!/bin/sh
# Drive's isolated fixture needs only its own bucket.
set -eu
awslocal s3api create-bucket --bucket "${DRIVE_S3_BUCKET:-opensuite-drive}" >/dev/null
