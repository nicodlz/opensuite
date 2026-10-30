#!/bin/sh
set -eu
trap 'printf "{\"component\":\"backup\",\"event\":\"restore_failure\"}\n"' EXIT
. "$(dirname "$0")/common.sh"
cleanup() { result=$?; trap - EXIT HUP INT TERM; if ! clean_stage; then result=1; log scratch_cleanup_failed; fi; if [ "$result" -eq 0 ]; then log restore_success; else log restore_failure; fi; exit "$result"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
log restore_start
[ ! -e .env ] || { echo 'restore: remove .env and use a new, empty project' >&2; exit 1; }
# Compose expands required Drive variables even before the saved .env is restored.
# These placeholders are used only by the isolated volume/restic helpers.
: "${DRIVE_S3_ENDPOINT:=http://invalid}" "${DRIVE_S3_PUBLIC_ENDPOINT:=http://invalid}" "${DRIVE_S3_BUCKET:=placeholder}" "${DRIVE_S3_REGION:=placeholder}" "${DRIVE_S3_ACCESS_KEY:=placeholder}" "${DRIVE_S3_SECRET_FILE:=/dev/null}"
export DRIVE_S3_ENDPOINT DRIVE_S3_PUBLIC_ENDPOINT DRIVE_S3_BUCKET DRIVE_S3_REGION DRIVE_S3_ACCESS_KEY DRIVE_S3_SECRET_FILE
# Verify empty named volumes before downloading or modifying anything.
compose run --rm --no-deps -T backup-volumes '[ -z "$(ls -A /secrets)" ] && [ -z "$(ls -A /stalwart)" ] && [ -z "$(ls -A /postgres)" ] && [ -z "$(ls -A /caddy-data)" ] && [ -z "$(ls -A /caddy-config)" ]' >&2
snapshot=${1:-latest}
# Restore only the captured subtree directly into the private stage.
compose run --rm --no-deps -T backup-restic 'exec restic restore "$1:/stage/data" --target /stage/data' sh "$snapshot" >&2
# Restic restores as container root. The invoking Docker operator must be able
# to read the private stage; archive-internal ownership remains in volumes.tar.
compose run --rm --no-deps -T backup-volumes 'chown -R "$1:$2" /stage/data' sh "$(id -u)" "$(id -g)" >&2
[ -s "$BACKUP_STAGE/data/config/env" ] && [ -s "$BACKUP_STAGE/data/volumes.tar" ] || { echo 'restore: snapshot is missing required files' >&2; exit 1; }
cp "$BACKUP_STAGE/data/config/env" .env
set -a
. ./.env
set +a
# Exported placeholders must not override values restored from the snapshot.
unset DRIVE_S3_ENDPOINT DRIVE_S3_PUBLIC_ENDPOINT DRIVE_S3_BUCKET DRIVE_S3_REGION DRIVE_S3_ACCESS_KEY DRIVE_S3_SECRET_FILE
set -a
. ./.env
set +a
restore_file() { # captured name, original destination, uid
  name=$1 path=$2 uid=$3
  [ -f "$BACKUP_STAGE/data/config/$name" ] || return 0
  [ "$path" != /dev/null ] && [ ! -e "$path" ] || { echo "restore: $name destination exists or is invalid" >&2; exit 1; }
  mkdir -p "$(dirname "$path")"
  cp "$BACKUP_STAGE/data/config/$name" "$path"
  chmod 0440 "$path"
  docker run --rm --network none --mount "type=bind,src=$path,dst=/secret" \
    alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
    chown "$uid:$uid" /secret >&2
}
restore_file drive-s3-secret "${DRIVE_S3_SECRET_FILE:?}" 999
restore_file ingest "${INGEST_ENV_FILE:-./deploy/ingest.env}" "$(id -u)"
restore_file observe "${OBSERVE_ENV_FILE:-./deploy/observe.env}" "$(id -u)"
restore_file relay "${MAIL_RELAY_SECRET_FILE:-/dev/null}" 2000
restore_file tls-cert "${MAIL_TLS_CERT_FILE:-/dev/null}" 2000
restore_file tls-key "${MAIL_TLS_KEY_FILE:-/dev/null}" 2000
if [ "${MAIL_BLOB_STORE:-local}" = s3 ]; then
  : "${MAIL_S3_SECRET_FILE:?}"
  [ ! -e "$MAIL_S3_SECRET_FILE" ] || { echo 'restore: mail secret already exists' >&2; exit 1; }
  mkdir -p "$(dirname "$MAIL_S3_SECRET_FILE")"
  cp "$BACKUP_STAGE/data/config/mail-s3-secret" "$MAIL_S3_SECRET_FILE"
  chmod 0440 "$MAIL_S3_SECRET_FILE"
  # Docker owns the destination; the controller need only have Docker access.
  docker run --rm --network none --mount "type=bind,src=$MAIL_S3_SECRET_FILE,dst=/secret" \
    alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
    chown 2000:2000 /secret >&2
fi
# Version/config mismatches can prevent opening RocksDB: recover the exact files.
cp "$BACKUP_STAGE/data/config/compose.yaml" compose.yaml
cp "$BACKUP_STAGE/data/config/stalwart.json" deploy/stalwart/config.json
cp "$BACKUP_STAGE/data/config/Caddyfile" deploy/caddy/Caddyfile
cp -R "$BACKUP_STAGE/data/config/initdb/." deploy/postgres/initdb/
objects restore mail
objects restore drive
compose run --rm --no-deps -T backup-volumes 'tar -xpf /stage/data/volumes.tar -C /' >&2
# Start only postgres; no application can migrate or write during the restore.
compose up -d --no-deps --wait --wait-timeout 180 postgres >&2
POSTGRES_USER=$(sed -n 1p "$BACKUP_STAGE/data/config/databases")
POSTGRES_DB=$(sed -n 2p "$BACKUP_STAGE/data/config/databases")
POSTGRES_DRIVE_DB=$(sed -n 3p "$BACKUP_STAGE/data/config/databases")
# initdb already creates the superuser. Restore its ALTER ROLE and all other roles.
sed "/^CREATE ROLE $POSTGRES_USER;$/d" "$BACKUP_STAGE/data/postgres/globals.sql" | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres >&2
for db in "$POSTGRES_DB" "$POSTGRES_DRIVE_DB"; do
  compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$db" --exit-on-error < "$BACKUP_STAGE/data/postgres/$db.dump" >&2
done
log restore_data_ready
