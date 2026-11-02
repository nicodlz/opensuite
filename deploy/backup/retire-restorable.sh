#!/bin/sh
# Remove an older proof pin only when a newer independently restored pin exists.
set -eu
. "$(dirname "$0")/common.sh"
[ "$#" = 3 ] && [ "$2" = --confirm-replacement ] || {
  echo 'usage: retire-restorable.sh OLD_ID --confirm-replacement NEW_ID' >&2; exit 1;
}
old_id=$1 new_id=$3
for id in "$old_id" "$new_id"; do
  case "$id" in *[!a-f0-9]*|'') echo 'backup: invalid snapshot ID' >&2; exit 1;; esac
  [ "${#id}" = 64 ] || { echo 'backup: supply full snapshot IDs' >&2; exit 1; }
done
[ "$old_id" != "$new_id" ] || { echo 'backup: replacement must be a different snapshot' >&2; exit 1; }
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! clean_stage; then result=1; log scratch_cleanup_failed; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
exec 9>"$BACKUP_SCRATCH/opensuite-backup.lock"
flock -n 9 || { log overlap; exit 1; }
sweep_stale
make_stage
old_info=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json "$1"' sh "$old_id")
new_info=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json "$1"' sh "$new_id")
for info in "$old_info" "$new_info"; do
  case "$info" in *'"opensuite-verified"'*'"opensuite-restorable"'*|*'"opensuite-restorable"'*'"opensuite-verified"'*) ;; *) echo 'backup: both snapshots must be verified and pinned' >&2; exit 1;; esac
  case "$info" in *'"opensuite-pending"'*) echo 'backup: pending snapshot cannot be used' >&2; exit 1;; esac
  case "$info" in *'"paths":["/stage/data"]'*) ;; *) echo 'backup: unexpected snapshot paths' >&2; exit 1;; esac
  count=$(printf '%s\n' "$info" | grep -o '"time":' | wc -l)
  [ "$count" = 1 ] || { echo 'backup: ambiguous snapshot information' >&2; exit 1; }
done
old_time=$(printf '%s\n' "$old_info" | sed -n 's/.*"time":"\([^"]*\)".*/\1/p')
new_time=$(printf '%s\n' "$new_info" | sed -n 's/.*"time":"\([^"]*\)".*/\1/p')
[ -n "$old_time" ] && [ -n "$new_time" ] || { echo 'backup: missing snapshot time' >&2; exit 1; }
old_epoch=$(date -u -d "$old_time" +%s) || { echo 'backup: invalid old snapshot time' >&2; exit 1; }
new_epoch=$(date -u -d "$new_time" +%s) || { echo 'backup: invalid replacement snapshot time' >&2; exit 1; }
now_epoch=$(date -u +%s)
[ "$new_epoch" -gt "$old_epoch" ] && [ "$new_epoch" -le "$((now_epoch + 60))" ] || {
  echo 'backup: replacement must be a newer, non-future recovery point' >&2; exit 1;
}
run_tag=$(printf '%s\n' "$old_info" | sed -n 's/.*"\(opensuite-run-[a-zA-Z0-9.-]*\)".*/\1/p')
[ -n "$run_tag" ] || { echo 'backup: snapshot has no unique run tag' >&2; exit 1; }
# Tagging creates a new snapshot ID; the replacement pin is never changed.
compose run --rm --no-deps -T backup-restic 'exec restic tag --remove opensuite-restorable "$1"' sh "$old_id" >&2
unpinned=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag "$1,opensuite-verified"' sh "$run_tag")
count=$(printf '%s\n' "$unpinned" | grep -o '"id":' | wc -l)
[ "$count" = 1 ] || { echo 'backup: cannot identify unpinned snapshot' >&2; exit 1; }
unpinned_id=$(printf '%s\n' "$unpinned" | sed -n 's/.*"id":"\([a-f0-9][a-f0-9]*\)".*/\1/p')
[ "${#unpinned_id}" = 64 ] || { echo 'backup: cannot identify unpinned snapshot' >&2; exit 1; }
printf '{"component":"backup","event":"snapshot_unpinned","old":"%s","snapshot":"%s","replacement":"%s"}\n' "$old_id" "$unpinned_id" "$new_id"
