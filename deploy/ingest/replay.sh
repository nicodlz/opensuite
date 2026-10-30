#!/bin/sh
# Serialize replay with backup so it cannot write during a snapshot.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
: "${BACKUP_CONFIG:=/etc/opensuite/backup.conf}"
[ -r "$BACKUP_CONFIG" ] || { echo 'replay: missing backup configuration' >&2; exit 1; }
. "$BACKUP_CONFIG"
: "${BACKUP_SCRATCH:?}"
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { echo 'replay: backup is running; retry on next timer' >&2; exit 1; }
exec docker compose --profile ingest run --rm --no-deps -T ingest node apps/ingest/src/main.ts replay
