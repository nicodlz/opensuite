#!/bin/sh
# Sourced by backup and restore. Config files are trusted shell assignments.
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
: "${BACKUP_CONFIG:=/etc/opensuite/backup.conf}"
[ -r "$BACKUP_CONFIG" ] || { echo 'backup: missing backup configuration' >&2; exit 1; }
set -a
. "$BACKUP_CONFIG"
set +a
: "${BACKUP_REPOSITORY:?}" "${BACKUP_PASSWORD_FILE:?}" "${BACKUP_ACCESS_KEY_ID:?}" "${BACKUP_SECRET_ACCESS_KEY:?}"
[ -s "$BACKUP_PASSWORD_FILE" ] || { echo 'backup: missing repository password' >&2; exit 1; }
# Scratch must be a private, encrypted filesystem, not tmpfs by assumption.
: "${BACKUP_SCRATCH:?set BACKUP_SCRATCH to a private encrypted filesystem}"
mkdir -p "$BACKUP_SCRATCH"
export BACKUP_REPOSITORY BACKUP_PASSWORD_FILE BACKUP_ACCESS_KEY_ID BACKUP_SECRET_ACCESS_KEY
BACKUP_STAGE=''
make_stage() { BACKUP_STAGE=$(mktemp -d "$BACKUP_SCRATCH/opensuite-backup.XXXXXXXX"); export BACKUP_STAGE; }
# Compose can be pointed at an isolated project/overlay for testing or recovery.
compose() {
  docker compose --profile "*" ${COMPOSE_PROJECT_NAME:+--project-name "$COMPOSE_PROJECT_NAME"} \
    -f "$ROOT/compose.yaml" -f "$ROOT/deploy/backup/compose.backup.yaml" ${BACKUP_COMPOSE_OVERRIDE:+-f "$BACKUP_COMPOSE_OVERRIDE"} "$@"
}
# Root-run helpers may create scratch files that the Docker-group operator
# cannot unlink. Remove those through a network-isolated pinned helper.
clean_dir() {
  dir=$1
  if ! rm -rf "$dir" 2>/dev/null; then
    docker run --rm --network none --mount "type=bind,src=$dir,dst=/stage" \
      alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
      sh -ec 'find /stage -mindepth 1 -delete' >&2
    rmdir "$dir"
  fi
}
clean_stage() { [ -z "$BACKUP_STAGE" ] || clean_dir "$BACKUP_STAGE"; }
sweep_stale() {
  for stale in "$BACKUP_SCRATCH"/opensuite-backup.*; do
    [ -d "$stale" ] && [ ! -L "$stale" ] || continue
    clean_dir "$stale" || return 1
    log stale_scratch_removed
  done
}
vault_secret_files() {
  printf '%s\n' "vault-admin:${VAULT_ADMIN_TOKEN_FILE:-/dev/null}" "vault-smtp:${VAULT_SMTP_SECRET_FILE:-/dev/null}" "vault-push:${VAULT_PUSH_KEY_FILE:-/dev/null}"
}
log() { printf '{"component":"backup","event":"%s","time":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
# Docker operators may not be able to read uid-restricted restored secrets on
# the host. Use an isolated helper when direct access is unavailable.
read_secret() {
  if [ -r "$1" ]; then cat "$1"; else
    docker run --rm --network none --mount "type=bind,src=$1,dst=/secret,readonly" \
      alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a cat /secret
  fi
}
# Exact path component names used by these services. A trailing slash makes the
# rclone source a directory/prefix rather than a similarly named sibling.
objects() { # save|preflight|restore|size, mail|drive, force
  direction=$1 kind=$2 object_force=${3:-0}
  if [ "$kind" = mail ]; then
    if [ "${MAIL_BLOB_STORE:-local}" != s3 ]; then [ "$direction" != size ] || echo 0; return 0; fi
    OBJECT_ENDPOINT=${MAIL_S3_ENDPOINT:?}; OBJECT_REGION=${MAIL_S3_REGION:?}
    OBJECT_ACCESS_KEY_ID=${MAIL_S3_KEY_ID:?}; OBJECT_SECRET_ACCESS_KEY=$(read_secret "${MAIL_S3_SECRET_FILE:?}")
    bucket=${MAIL_S3_BUCKET:?}; prefix=${MAIL_S3_PREFIX:-}
  else
    OBJECT_ENDPOINT=${DRIVE_S3_ENDPOINT:?}; OBJECT_REGION=${DRIVE_S3_REGION:?}
    OBJECT_ACCESS_KEY_ID=${DRIVE_S3_ACCESS_KEY:?}; OBJECT_SECRET_ACCESS_KEY=$(read_secret "${DRIVE_S3_SECRET_FILE:?}")
    bucket=${DRIVE_S3_BUCKET:?}; prefix=${DRIVE_S3_PREFIX:-}
  fi
  export OBJECT_ENDPOINT OBJECT_REGION OBJECT_ACCESS_KEY_ID OBJECT_SECRET_ACCESS_KEY
  case "$prefix" in ''|*/) ;; *) echo 'backup: object prefix must be empty or end in /' >&2; return 1;; esac
  remote="store:$bucket/${prefix}"
  if [ "$direction" = size ]; then
    # Keep rclone's own exit status; a pipeline would report only sed's.
    sizes=$(compose run --rm --no-deps -T backup-objects 'exec rclone size "$1" --json' sh "$remote") ||
      { echo "backup: could not measure $kind objects" >&2; return 1; }
    bytes=$(printf '%s\n' "$sizes" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
    [ -n "$bytes" ] || { echo "backup: could not measure $kind objects" >&2; return 1; }
    echo "$bytes"
    return 0
  fi
  if [ "$direction" = save ]; then
    mkdir -p "$BACKUP_STAGE/data/objects/$kind"
    compose run --rm --no-deps -T backup-objects 'exec rclone copy "$1" "$2" --s3-no-check-bucket' sh "$remote" "/stage/data/objects/$kind" >&2
    compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --download' sh "$remote" "/stage/data/objects/$kind" >&2
  elif [ "$direction" = preflight ]; then
    listing=$(compose run --rm --no-deps -T backup-objects 'exec rclone lsf "$1" --recursive' sh "$remote") || return 1
    if [ -n "$listing" ]; then
      [ "$object_force" = 1 ] || { echo "backup: $kind restore prefix is not empty" >&2; return 1; }
      # Existing objects must be an exact subset of the snapshot, including bytes.
      compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --one-way --download' sh "$remote" "/stage/data/objects/$kind" >&2 || { echo "backup: $kind restore prefix differs from snapshot" >&2; return 1; }
    fi
    compose run --rm --no-deps -T backup-objects 'exec rclone copy "$1" "$2" --ignore-existing --dry-run --s3-no-check-bucket' sh "/stage/data/objects/$kind" "$remote" >&2
  else
    compose run --rm --no-deps -T backup-objects 'exec rclone copy "$1" "$2" --ignore-existing --s3-no-check-bucket' sh "/stage/data/objects/$kind" "$remote" >&2
    compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --download' sh "/stage/data/objects/$kind" "$remote" >&2
  fi
}
