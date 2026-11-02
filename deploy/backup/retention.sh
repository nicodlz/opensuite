#!/bin/sh
# Apply the normal policy without taking a new backup, e.g. after a budget stop.
set -eu
. "$(dirname "$0")/common.sh"
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! clean_stage; then result=1; log scratch_cleanup_failed; fi
  if [ "$result" -eq 0 ]; then log retention_maintenance_success; else log retention_maintenance_failure; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
[ "$#" = 0 ] || { echo 'usage: retention.sh' >&2; exit 1; }
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
sweep_stale
make_stage
retention_policy
# Do not force-unlock a live writer on this host or any other host.
compose run --rm --no-deps -T backup-restic 'exec restic unlock' >&2
pin_time=$(latest_restorable_time)
[ -n "$pin_time" ] || { echo 'backup: independent restore pin required before retention' >&2; log retention_waiting_restore; exit 1; }
apply_retention "$pin_time"
