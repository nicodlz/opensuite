#!/bin/sh
# Runs in the isolated backup-stream helper. All paths under /stage are private.
set -eu
mkdir -p /tmp/bin /tmp/repository
ln -sf /usr/bin/fusermount3 /tmp/bin/fusermount
PATH=/tmp/bin:$PATH
export PATH
repo_pid=''
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  for mount in /tmp/repository /stage/data/objects/mail /stage/data/objects/drive; do
    if mountpoint -q "$mount"; then fusermount3 -u "$mount" || result=1; fi
  done
  if [ -n "$repo_pid" ]; then wait "$repo_pid" || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mount_snapshot() {
  /stage/restic mount /tmp/repository >&2 &
  repo_pid=$!
  attempt=0
  until mountpoint -q /tmp/repository; do
    kill -0 "$repo_pid" 2>/dev/null || { echo 'backup: repository mount failed' >&2; return 1; }
    attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || { echo 'backup: repository mount timed out' >&2; return 1; }
    sleep 1
  done
}
case "$1" in
  capture)
    mkdir -p /stage/data/objects/mail /stage/data/objects/drive
    if [ "$2" != - ]; then rclone mount "$2" /stage/data/objects/mail --read-only --vfs-cache-mode off --buffer-size 8M --daemon; fi
    rclone mount "$3" /stage/data/objects/drive --read-only --vfs-cache-mode off --buffer-size 8M --daemon
    if [ "$2" != - ]; then mountpoint -q /stage/data/objects/mail; fi
    mountpoint -q /stage/data/objects/drive
    /stage/restic backup --force --json --tag opensuite-pending --tag "$4" /stage/data > /stage/snapshot-result.json
    ;;
  verify)
    mount_snapshot
    short=$(printf '%s' "$2" | cut -c1-8)
    saved="/tmp/repository/ids/$short/stage/data"
    # Read and compare every captured byte before allowing retention.
    rclone check /stage/data "$saved" --download --links --exclude 'objects/**' --checkers 1 >&2
    if [ -f /stage/data/config/objects-mail.sha256 ]; then
      rclone checksum SHA256 /stage/data/config/objects-mail.sha256 "$saved/objects/mail" --download --checkers 1 >&2
    fi
    rclone checksum SHA256 /stage/data/config/objects-drive.sha256 "$saved/objects/drive" --download --checkers 1 >&2
    ;;
  preflight|restore)
    action=$1; snapshot=$2; kind=$3; remote=$4; force=${5:-0}
    mount_snapshot
    short=$(printf '%s' "$snapshot" | cut -c1-8)
    saved="/tmp/repository/ids/$short/stage/data/objects/$kind"
    if [ "$action" = preflight ]; then
      listing=$(rclone lsf "$remote" --recursive) || exit 1
      if [ -n "$listing" ]; then
        [ "$force" = 1 ] || { echo "backup: $kind restore prefix is not empty" >&2; exit 1; }
        rclone check "$remote" "$saved" --one-way --download --checkers 1 >&2 || { echo "backup: $kind restore prefix differs from snapshot" >&2; exit 1; }
      fi
      rclone copy "$saved" "$remote" --ignore-existing --dry-run --s3-no-check-bucket --transfers 1 >&2
    else
      rclone copy "$saved" "$remote" --ignore-existing --s3-no-check-bucket --transfers 1 >&2
      rclone check "$saved" "$remote" --download --checkers 1 >&2
    fi
    ;;
  *) echo 'backup: unknown stream action' >&2; exit 1;;
esac
