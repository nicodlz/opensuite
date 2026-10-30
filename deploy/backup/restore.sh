#!/bin/sh
set -eu
trap 'printf "{\"component\":\"backup\",\"event\":\"restore_failure\"}\n"' EXIT
. "$(dirname "$0")/common.sh"
cleanup() { result=$?; trap - EXIT HUP INT TERM; if ! clean_stage; then result=1; log scratch_cleanup_failed; fi; if [ "$result" -eq 0 ]; then log restore_success; else log restore_failure; fi; exit "$result"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
sweep_stale
make_stage
log restore_start
force=0
production_override=0
target_project=${COMPOSE_PROJECT_NAME:-}
env_project() (
  unset COMPOSE_PROJECT_NAME
  set -a
  . "$1" >/dev/null
  printf '%s' "${COMPOSE_PROJECT_NAME:-}"
)
protect_project() { # repository name or a trusted env file's project name
  [ -z "$1" ] || [ "$target_project" != "$1" ] || [ "$production_override" = 1 ] || {
    echo 'restore: target matches a production project name; --i-understand-this-is-production is required' >&2; return 1;
  }
}
if [ "${1:-}" = --force ]; then
  force=1; shift
  [ "${1:-}" = --confirm-project ] && [ -n "${2:-}" ] && [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$2" = "$COMPOSE_PROJECT_NAME" ] || { echo 'restore: --force requires COMPOSE_PROJECT_NAME and --confirm-project with the same isolated project name' >&2; exit 1; }
  shift 2
  if [ "${1:-}" = --i-understand-this-is-production ]; then production_override=1; shift; log production_force_acknowledged; fi
  protect_project opensuite
  compose_name=$(awk '/^name:[[:space:]]*/ {sub(/^name:[[:space:]]*/, ""); sub(/[[:space:]]+#.*/, ""); gsub(/^[\047"]|[\047"]$/, ""); print; exit}' "$ROOT/compose.yaml")
  case "$compose_name" in *[!a-z0-9_-]*|'')
    [ "$production_override" = 1 ] || { echo 'restore: repository project name cannot be determined; production acknowledgement is required' >&2; exit 1; };;
    *) protect_project "$compose_name";;
  esac
  if [ -f .env ]; then current_project=$(env_project ./.env); protect_project "$current_project"; fi
  log force_confirmed
fi
[ "$#" -le 1 ] || { echo 'usage: restore.sh [--force --confirm-project PROJECT [--i-understand-this-is-production]] [snapshot-id]' >&2; exit 1; }
if [ "$force" = 0 ]; then
  [ ! -e .env ] || { echo 'restore: remove .env and use a new, empty project, or use --force' >&2; exit 1; }
fi
# Compose expands required Drive variables even before the saved .env is restored.
# These placeholders are used only by the isolated volume/restic helpers.
: "${DRIVE_S3_ENDPOINT:=http://invalid}" "${DRIVE_S3_PUBLIC_ENDPOINT:=http://invalid}" "${DRIVE_S3_BUCKET:=placeholder}" "${DRIVE_S3_REGION:=placeholder}" "${DRIVE_S3_ACCESS_KEY:=placeholder}" "${DRIVE_S3_SECRET_FILE:=/dev/null}"
export DRIVE_S3_ENDPOINT DRIVE_S3_PUBLIC_ENDPOINT DRIVE_S3_BUCKET DRIVE_S3_REGION DRIVE_S3_ACCESS_KEY DRIVE_S3_SECRET_FILE
# Verify empty named volumes before downloading or modifying anything.
if [ "$force" = 0 ]; then
  compose run --rm --no-deps -T backup-volumes '[ -z "$(ls -A /secrets)" ] && [ -z "$(ls -A /stalwart)" ] && [ -z "$(ls -A /postgres)" ] && [ -z "$(ls -A /caddy-data)" ] && [ -z "$(ls -A /caddy-config)" ] && [ -z "$(ls -A /pass-data)" ]' >&2 || { echo 'restore: target volumes are not empty; use --force only on an isolated target' >&2; exit 1; }
else
  services=$(compose ps --services --filter status=running)
  [ -z "$services" ] || { echo 'restore: stop all target services before --force' >&2; exit 1; }
fi
snapshot=${1:-latest}
# Restore only the captured subtree directly into the private stage.
compose run --rm --no-deps -T backup-restic 'exec restic restore "$1:/stage/data" --target /stage/data' sh "$snapshot" >&2
# Restic restores as container root. The invoking Docker operator must be able
# to read the private stage; archive-internal ownership remains in volumes.tar.
compose run --rm --no-deps -T backup-volumes 'chown -R "$1:$2" /stage/data' sh "$(id -u)" "$(id -g)" >&2
[ -s "$BACKUP_STAGE/data/config/env" ] && [ -s "$BACKUP_STAGE/data/volumes.tar" ] || { echo 'restore: snapshot is missing required files' >&2; exit 1; }
if [ "$force" = 1 ]; then
  saved_project=$(env_project "$BACKUP_STAGE/data/config/env")
  protect_project "$saved_project"
fi
pass_restore=0
if [ -f "$BACKUP_STAGE/data/config/pass-enabled" ]; then
  pass_restore=1
  [ -s "$BACKUP_STAGE/data/postgres/opensuite_pass.dump" ] && [ -s "$BACKUP_STAGE/data/pass-volume.tar" ] || { echo 'restore: Pass snapshot is incomplete' >&2; exit 1; }
fi
# Read the saved configuration in memory for preflight; do not replace .env or
# any local state before both object destinations have been checked.
unset DRIVE_S3_ENDPOINT DRIVE_S3_PUBLIC_ENDPOINT DRIVE_S3_BUCKET DRIVE_S3_REGION DRIVE_S3_ACCESS_KEY DRIVE_S3_SECRET_FILE
set -a
. "$BACKUP_STAGE/data/config/env"
set +a
if [ -n "$target_project" ]; then
  COMPOSE_PROJECT_NAME=$target_project; export COMPOSE_PROJECT_NAME
elif [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  echo 'restore: saved project name requires an explicit isolated COMPOSE_PROJECT_NAME' >&2; exit 1
fi
if [ "$pass_restore" = 1 ]; then
  while IFS= read -r item; do
    name=${item%%:*}; path=${item#*:}
    [ "$path" = /dev/null ] || [ -s "$BACKUP_STAGE/data/config/$name" ] || { echo "restore: snapshot is missing $name" >&2; exit 1; }
  done <<PASS_SECRETS
$(pass_secret_files)
PASS_SECRETS
fi
saved_drive_secret=${DRIVE_S3_SECRET_FILE:?}
saved_mail_secret=${MAIL_S3_SECRET_FILE:-/dev/null}
DRIVE_S3_SECRET_FILE="$BACKUP_STAGE/data/config/drive-s3-secret"
if [ "${MAIL_BLOB_STORE:-local}" = s3 ]; then MAIL_S3_SECRET_FILE="$BACKUP_STAGE/data/config/mail-s3-secret"; fi
export DRIVE_S3_SECRET_FILE MAIL_S3_SECRET_FILE
objects preflight mail "$force"
objects preflight drive "$force"
log restore_preflight_ok
DRIVE_S3_SECRET_FILE=$saved_drive_secret MAIL_S3_SECRET_FILE=$saved_mail_secret
export DRIVE_S3_SECRET_FILE MAIL_S3_SECRET_FILE
if [ "$force" = 1 ]; then
  compose run --rm --no-deps -T backup-volumes 'for dir in /secrets /stalwart /postgres /caddy-data /caddy-config /pass-data; do find "$dir" -mindepth 1 -delete; done' >&2
fi
cp "$BACKUP_STAGE/data/config/env" .env
restore_file() { # captured name, original destination, uid
  name=$1 path=$2 uid=$3
  [ -f "$BACKUP_STAGE/data/config/$name" ] || return 0
  [ "$path" != /dev/null ] && [ ! -L "$path" ] || { echo "restore: $name destination is invalid" >&2; exit 1; }
  if [ -e "$path" ]; then
    [ "$force" = 1 ] && [ -f "$path" ] || { echo "restore: $name destination exists; use --force only on an isolated target" >&2; exit 1; }
    rm -f "$path"
  fi
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
if [ "$pass_restore" = 1 ]; then
  while IFS= read -r item; do
    name=${item%%:*}; path=${item#*:}
    restore_file "$name" "$path" 1000
  done <<PASS_SECRETS
$(pass_secret_files)
PASS_SECRETS
fi
if [ "${MAIL_BLOB_STORE:-local}" = s3 ]; then
  restore_file mail-s3-secret "${MAIL_S3_SECRET_FILE:?}" 2000
fi
# Version/config mismatches can prevent opening RocksDB: recover the exact files.
cp "$BACKUP_STAGE/data/config/compose.yaml" compose.yaml
cp "$BACKUP_STAGE/data/config/stalwart.json" deploy/stalwart/config.json
cp "$BACKUP_STAGE/data/config/Caddyfile" deploy/caddy/Caddyfile
[ "$force" = 0 ] || find deploy/postgres/initdb -mindepth 1 -delete
cp -Rp "$BACKUP_STAGE/data/config/initdb/." deploy/postgres/initdb/
# Older snapshots staged bootstrap scripts with a restrictive umask. Grant
# PostgreSQL's group access without making operator-provided scripts public.
docker run --rm --network none --mount "type=bind,src=$ROOT/deploy/postgres/initdb,dst=/init" \
  alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
  sh -ec 'chgrp -R 999 /init; chmod -R g+rX /init' >&2
objects restore mail "$force"
objects restore drive "$force"
compose run --rm --no-deps -T backup-volumes 'tar -xpf /stage/data/volumes.tar -C /' >&2
if [ "$pass_restore" = 1 ]; then
  compose run --rm --no-deps -T backup-volumes 'tar -xpf /stage/data/pass-volume.tar -C / && chown -R 1000:1000 /pass-data && chmod 0700 /pass-data && [ -s /pass-data/rsa_key.pem ] && [ -s /secrets/pass-database/password ]' >&2
fi
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
if [ "$pass_restore" = 1 ]; then
  # Provision the dedicated database with the restored credential, then load
  # objects with their original ownership. The service itself stays stopped.
  compose run --rm --no-deps -T pass-provision >&2
  compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d opensuite_pass --exit-on-error < "$BACKUP_STAGE/data/postgres/opensuite_pass.dump" >&2
fi
log restore_data_ready
