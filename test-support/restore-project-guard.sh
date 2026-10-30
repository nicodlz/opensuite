#!/bin/sh
# Isolated command-level tests; no Docker daemon or external repository.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d /tmp/esuno-restore-guard.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/repo/deploy/backup" "$work/bin" "$work/scratch"
cp "$root/deploy/backup/restore.sh" "$root/deploy/backup/common.sh" "$work/repo/deploy/backup/"
printf 'name: esuno-primary\n' > "$work/repo/compose.yaml"
printf 'fixture\n' > "$work/password"
cat > "$work/config" <<CONFIG
BACKUP_REPOSITORY=fixture
BACKUP_ACCESS_KEY_ID=fixture
BACKUP_SECRET_ACCESS_KEY=fixture
BACKUP_PASSWORD_FILE=$work/password
BACKUP_SCRATCH=$work/scratch
CONFIG
cat > "$work/bin/docker" <<'MOCK'
#!/bin/sh
case "$*" in
  *'ps --services'*) exit 0 ;;
  *'restic restore'*)
    mkdir -p "$BACKUP_STAGE/data/config"
    printf 'COMPOSE_PROJECT_NAME=savedprod\nDRIVE_S3_ENDPOINT=http://fixture\nDRIVE_S3_REGION=fixture\nDRIVE_S3_BUCKET=fixture\nDRIVE_S3_ACCESS_KEY=fixture\nDRIVE_S3_SECRET_FILE=/fixture\n' > "$BACKUP_STAGE/data/config/env"
    if [ "${OMIT_SAVED_SECRET:-0}" = 1 ]; then sed -i '/^DRIVE_S3_SECRET_FILE=/d' "$BACKUP_STAGE/data/config/env"; fi
    printf fixture > "$BACKUP_STAGE/data/config/drive-s3-secret"
    printf fixture > "$BACKUP_STAGE/data/volumes.tar"
    exit 0 ;;
  *'backup-volumes'*) exit 0 ;;
  *'backup-objects'*'rclone lsf'*) exit 0 ;;
  *'backup-objects'*'rclone copy'*) echo 'fixture: preflight reached' >&2; exit 1 ;;
  *) echo 'fixture: unexpected docker call' >&2; exit 1 ;;
esac
MOCK
chmod +x "$work/bin/docker"
export BACKUP_CONFIG="$work/config" PATH="$work/bin:$PATH"
cd "$work/repo"
reject() {
  project=$1; shift
  if COMPOSE_PROJECT_NAME="$project" ./deploy/backup/restore.sh --force --confirm-project "$project" "$@" > "$work/stdout" 2> "$work/stderr"; then
    echo "guard: unexpectedly accepted $project" >&2; exit 1
  fi
  grep -Fq -- '--i-understand-this-is-production is required' "$work/stderr"
}
reject opensuite
reject esuno-primary
printf 'COMPOSE_PROJECT_NAME=currentprod\n' > .env
reject currentprod
rm .env
reject savedprod
if COMPOSE_PROJECT_NAME=savedprod ./deploy/backup/restore.sh --force --confirm-project savedprod --i-understand-this-is-production > "$work/stdout" 2> "$work/stderr"; then
  echo 'guard: fixture preflight unexpectedly succeeded' >&2; exit 1
fi
grep -Fq 'production_force_acknowledged' "$work/stdout"
grep -Fq 'fixture: preflight reached' "$work/stderr"
if OMIT_SAVED_SECRET=1 DRIVE_S3_SECRET_FILE=/placeholder COMPOSE_PROJECT_NAME=isolated ./deploy/backup/restore.sh --force --confirm-project isolated > "$work/stdout" 2> "$work/stderr"; then
  echo 'guard: missing saved Drive secret unexpectedly accepted' >&2; exit 1
fi
grep -Fq 'DRIVE_S3_SECRET_FILE' "$work/stderr"
printf '%s\n' 'Restore project guard: 6 cases passed.'
