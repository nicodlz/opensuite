#!/bin/sh
# Operator attestation after completing an independent isolated restore.
set -eu
. "$(dirname "$0")/common.sh"
[ "$#" = 3 ] && [ "$2" = --confirm-restored ] && [ "$3" = "$1" ] || {
  echo 'usage: mark-restorable.sh SNAPSHOT_ID --confirm-restored SNAPSHOT_ID' >&2; exit 1;
}
snapshot=$1
case "$snapshot" in *[!a-f0-9]*|'') echo 'backup: invalid snapshot ID' >&2; exit 1;; esac
[ "${#snapshot}" = 64 ] || { echo 'backup: supply the full snapshot ID' >&2; exit 1; }
trap 'clean_stage' EXIT HUP INT TERM
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
sweep_stale
make_stage
info=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json "$1"' sh "$snapshot")
case "$info" in *'"opensuite-verified"'*) ;; *) echo 'backup: snapshot has not passed byte verification' >&2; exit 1;; esac
case "$info" in *'"opensuite-pending"'*) echo 'backup: pending snapshot cannot be marked restorable' >&2; exit 1;; esac
run_tag=$(printf '%s\n' "$info" | sed -n 's/.*"\(opensuite-run-[a-zA-Z0-9.-]*\)".*/\1/p')
[ -n "$run_tag" ] || { echo 'backup: snapshot has no unique run tag' >&2; exit 1; }
compose run --rm --no-deps -T backup-restic 'exec restic tag --add opensuite-restorable "$1"' sh "$snapshot" >&2
marked=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag "$1,opensuite-restorable"' sh "$run_tag")
marked_id=$(printf '%s\n' "$marked" | sed -n 's/.*"id":"\([a-f0-9][a-f0-9]*\)".*/\1/p')
[ "${#marked_id}" = 64 ] || { echo 'backup: cannot identify restorable snapshot' >&2; exit 1; }
printf '{"component":"backup","event":"snapshot_restorable","snapshot":"%s"}\n' "$marked_id"
