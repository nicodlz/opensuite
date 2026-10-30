#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
trap 'clean_stage' EXIT HUP INT TERM
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
sweep_stale
make_stage
# Explicit one-time creation; an unavailable or wrong repository never triggers init.
compose run --rm --no-deps -T backup-restic 'exec restic init'
