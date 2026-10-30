#!/bin/sh
set -eu
trap 'printf "{\"component\":\"backup\",\"event\":\"failure\"}\n"' EXIT
. "$(dirname "$0")/common.sh"
running=''
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ -n "$running" ]; then
    # Services were running before quiescing; restart even after failure.
    if ! compose start $running >&2; then result=1; log restart_failed; fi
  fi
  if ! clean_stage; then result=1; log scratch_cleanup_failed; fi
  if [ "$result" -eq 0 ]; then
    marker_dir=${OBSERVE_BACKUP_DIR:-./deploy/backup-status}
    if ! (umask 022; mkdir -p "$marker_dir" && marker=$(mktemp "$marker_dir/.last-success.XXXXXXXX") &&
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker" && mv -f "$marker" "$marker_dir/last-success"); then
      result=1
      log marker_failed
    fi
  fi
  if [ "$result" -eq 0 ]; then log success; else log failure; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# flock protects against overlapping scheduled/manual runs on this host.
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
log start
[ -r .env ] || { echo 'backup: .env is required' >&2; exit 1; }
set -a
. ./.env
set +a
: "${POSTGRES_USER:=opensuite}" "${POSTGRES_DB:=opensuite}" "${POSTGRES_DRIVE_DB:=opensuite_drive}"
for ident in "$POSTGRES_USER" "$POSTGRES_DB" "$POSTGRES_DRIVE_DB"; do
  case "$ident" in [a-z_]* ) ;; *) echo 'backup: database and role names must be lowercase identifiers' >&2; exit 1;; esac
  case "$ident" in *[!a-z0-9_]* ) echo 'backup: database and role names must be lowercase identifiers' >&2; exit 1;; esac
done
[ "$POSTGRES_DB" != "$POSTGRES_DRIVE_DB" ] || exit 1
compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >&2
# The saved registry, not .env, is authoritative for the active blob store.
# Refuse to omit a mail bucket when the two configurations disagree.
blob=$(compose run --rm --no-deps -T backup-management '
  password=$(cat /run/opensuite/stalwart-management/password)
  self=$(hostname -i | cut -d" " -f1)
  curl -fsS -u "management@opensuite.internal:$password" -H "X-Forwarded-For: $self" -H "Content-Type: application/json" \
    http://stalwart-management:8080/jmap/ -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:BlobStore/get\",{\"ids\":[\"singleton\"]},\"b\"]]}"
')
case "${MAIL_BLOB_STORE:-local}" in
  local) printf '%s' "$blob" | grep -Fq '"@type":"Default"' || { echo 'backup: active mail blob configuration differs from .env' >&2; exit 1; } ;;
  s3)
    for field in '"@type":"S3"' "\"bucket\":\"${MAIL_S3_BUCKET:?}\"" "\"url\":\"${MAIL_S3_ENDPOINT:?}\"" "\"region\":\"${MAIL_S3_REGION:?}\""; do
      printf '%s' "$blob" | grep -Fq "$field" || { echo 'backup: active mail blob configuration differs from .env' >&2; exit 1; }
    done
    if [ -n "${MAIL_S3_PREFIX:-}" ]; then prefix_field="\"keyPrefix\":\"$MAIL_S3_PREFIX\""; else prefix_field='"keyPrefix":null'; fi
    printf '%s' "$blob" | grep -Fq "$prefix_field" || { echo 'backup: active mail prefix differs from .env' >&2; exit 1; }
    ;;
  *) echo 'backup: unknown mail blob store' >&2; exit 1 ;;
esac
# Objects are copied to scratch while services are stopped. Refuse before
# stopping anything when they cannot fit, keeping a reserve for dumps and
# volumes (BACKUP_SCRATCH_RESERVE_BYTES, default 4 GiB).
mail_bytes=$(objects size mail)
drive_bytes=$(objects size drive)
needed=$((mail_bytes + drive_bytes + ${BACKUP_SCRATCH_RESERVE_BYTES:-4294967296}))
available=$(df -Pk "$BACKUP_STAGE" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')
if [ "$needed" -gt "$available" ]; then
  echo "backup: scratch too small: need $needed bytes (mail $mail_bytes, drive $drive_bytes, reserve), $available available" >&2
  log scratch_too_small
  exit 1
fi
log scratch_checked
running=$(compose ps --services --filter status=running | awk '/^(caddy|api|drive|stalwart|ingest|observe)$/ {print}')
# Stop clients and workers before any snapshot; operators must stop external writers.
[ -z "$running" ] || compose stop $running >&2
log quiesced
mkdir -p "$BACKUP_STAGE/data/config" "$BACKUP_STAGE/data/postgres"
cp .env "$BACKUP_STAGE/data/config/env"
cp "$BACKUP_CONFIG" "$BACKUP_STAGE/data/config/backup.conf"
cp deploy/stalwart/config.json "$BACKUP_STAGE/data/config/stalwart.json"
cp deploy/caddy/Caddyfile "$BACKUP_STAGE/data/config/Caddyfile"
# Preserve the full Compose definition, init scripts and image pins for recovery.
cp compose.yaml "$BACKUP_STAGE/data/config/compose.yaml"
git rev-parse HEAD > "$BACKUP_STAGE/data/config/git-revision"
cp -R deploy/postgres/initdb "$BACKUP_STAGE/data/config/initdb"
if [ "${MAIL_BLOB_STORE:-local}" = s3 ]; then cp "${MAIL_S3_SECRET_FILE:?}" "$BACKUP_STAGE/data/config/mail-s3-secret"; fi
cp "${DRIVE_S3_SECRET_FILE:?}" "$BACKUP_STAGE/data/config/drive-s3-secret"
for item in "ingest:${INGEST_ENV_FILE:-./deploy/ingest.env}" "observe:${OBSERVE_ENV_FILE:-./deploy/observe.env}" \
  "relay:${MAIL_RELAY_SECRET_FILE:-/dev/null}" "tls-cert:${MAIL_TLS_CERT_FILE:-/dev/null}" "tls-key:${MAIL_TLS_KEY_FILE:-/dev/null}"; do
  name=${item%%:*}; path=${item#*:}
  if [ "$path" != /dev/null ] && [ -f "$path" ]; then cp "$path" "$BACKUP_STAGE/data/config/$name"; fi
done
if [ "${MAIL_RELAY_CONFIGURED:-0}" = 1 ] && [ ! -s "$BACKUP_STAGE/data/config/relay" ]; then
  echo 'backup: configured relay secret is missing' >&2; exit 1
fi
if [ "${MAIL_TLS_ENABLED:-0}" = 1 ] && { [ ! -s "$BACKUP_STAGE/data/config/tls-cert" ] || [ ! -s "$BACKUP_STAGE/data/config/tls-key" ]; }; then
  echo 'backup: configured TLS files are missing' >&2; exit 1
fi
printf '%s\n' "$POSTGRES_USER" "$POSTGRES_DB" "$POSTGRES_DRIVE_DB" > "$BACKUP_STAGE/data/config/databases"
compose exec -T -e PGPASSWORD="$(compose exec -T postgres cat /run/opensuite/postgres/password)" postgres pg_dumpall -h localhost -U "$POSTGRES_USER" --globals-only > "$BACKUP_STAGE/data/postgres/globals.sql"
for db in "$POSTGRES_DB" "$POSTGRES_DRIVE_DB"; do
  compose exec -T -e PGPASSWORD="$(compose exec -T postgres cat /run/opensuite/postgres/password)" postgres pg_dump -h localhost -U "$POSTGRES_USER" -Fc -d "$db" > "$BACKUP_STAGE/data/postgres/$db.dump"
done
compose run --rm --no-deps -T backup-volumes 'tar -cpf /stage/data/volumes.tar -C / secrets stalwart caddy-data caddy-config' >&2
objects save mail
objects save drive
# Restore service promptly; upload and retention do not extend downtime.
if [ -n "$running" ]; then compose start $running >&2; running=''; fi
log captured
compose run --rm --no-deps -T backup-restic 'exec restic backup --json /stage/data' >&2
# Only forget after a complete successful snapshot. Never auto-init on error.
compose run --rm --no-deps -T backup-restic 'exec restic forget --group-by paths --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune' >&2
