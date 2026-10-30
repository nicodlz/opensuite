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
BACKUP_STAGE=$(mktemp -d "$BACKUP_SCRATCH/opensuite-backup.XXXXXXXX")
export BACKUP_STAGE BACKUP_REPOSITORY BACKUP_PASSWORD_FILE BACKUP_ACCESS_KEY_ID BACKUP_SECRET_ACCESS_KEY
# Compose can be pointed at an isolated project/overlay for testing or recovery.
compose() {
  docker compose --profile "*" ${COMPOSE_PROJECT_NAME:+--project-name "$COMPOSE_PROJECT_NAME"} \
    -f "$ROOT/compose.yaml" -f "$ROOT/deploy/backup/compose.backup.yaml" ${BACKUP_COMPOSE_OVERRIDE:+-f "$BACKUP_COMPOSE_OVERRIDE"} "$@"
}
# Root-run helpers may create scratch files that the Docker-group operator
# cannot unlink. Remove those through a network-isolated pinned helper.
clean_stage() {
  if ! rm -rf "$BACKUP_STAGE" 2>/dev/null; then
    docker run --rm --network none --mount "type=bind,src=$BACKUP_STAGE,dst=/stage" \
      alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
      sh -ec 'find /stage -mindepth 1 -delete' >&2
    rmdir "$BACKUP_STAGE"
  fi
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
objects() { # direction, mail|drive
  direction=$1 kind=$2
  if [ "$kind" = mail ]; then
    [ "${MAIL_BLOB_STORE:-local}" = s3 ] || return 0
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
  if [ "$direction" = save ]; then
    mkdir -p "$BACKUP_STAGE/data/objects/$kind"
    compose run --rm --no-deps -T backup-objects 'exec rclone copy "$1" "$2" --s3-no-check-bucket' sh "$remote" "/stage/data/objects/$kind" >&2
    compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --download' sh "$remote" "/stage/data/objects/$kind" >&2
  else
    # Never overwrite a live prefix; a recovery bucket must be empty.
    listing=$(compose run --rm --no-deps -T backup-objects 'exec rclone lsf "$1" --recursive' sh "$remote")
    if [ -n "$listing" ]; then
      if [ "${force:-0}" = 1 ]; then
        # An exact match is an idempotent retry; never overwrite changed objects.
        compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --download' sh "/stage/data/objects/$kind" "$remote" >&2 || { echo "backup: $kind restore prefix differs from snapshot" >&2; return 1; }
        return 0
      fi
      echo "backup: $kind restore prefix is not empty" >&2; return 1
    fi
    compose run --rm --no-deps -T backup-objects 'exec rclone copy "$1" "$2" --s3-no-check-bucket' sh "/stage/data/objects/$kind" "$remote" >&2
    compose run --rm --no-deps -T backup-objects 'exec rclone check "$1" "$2" --download' sh "/stage/data/objects/$kind" "$remote" >&2
  fi
}
