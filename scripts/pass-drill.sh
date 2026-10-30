#!/bin/sh
# Sourced by the integration harness; --list is the report's single case registry.
pass_drill_cases() {
  cat <<'CASES'
create user, encrypted item and attachment
Pass capture failure alerts and restarts service
stopped Pass and missing RSA key fail capture
real encrypted backup and success marker
nonempty target refused
fresh database, secrets and identical RSA key
login, decrypt item and download attachment
force preflight protects local state
partial object restore
explicit isolated restore retry
CASES
}
if [ "${1:-}" = --list ]; then pass_drill_cases; exit 0; fi
pass_client() { NODE_EXTRA_CA_CERTS="$work/caddy-ca" node "$root/test-support/pass-drill-client.mjs" "$1" "https://127.0.0.1:$passport" "$work"; }
pass_case_create() {
  compose --profile pass up -d --wait --wait-timeout 180 pass caddy
  passport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  pass_client create
  rsa=$(compose exec -T pass sha256sum /data/rsa_key.pem | awk '{print $1}')
  case_done 'create user, encrypted item and attachment'
}
pass_case_failure() {
  # A concurrent invocation must not publish a false failure marker.
  (
    flock -x 8
    if ./deploy/backup/backup.sh; then echo 'overlapping backup unexpectedly ran' >&2; exit 1; fi
    [ ! -e "$work/source/deploy/backup-status/last-failure" ]
  ) 8>"$work/scratch/opensuite-backup.lock"
  mkdir "$work/scratch/opensuite-backup.stale-fixture"
  printf stale > "$work/scratch/opensuite-backup.stale-fixture/data"
  # Simulate an enabled but unreadable data set; a failed capture must restart Pass
  # and publish a Pass-specific failure without refreshing the success marker.
  cp "$work/secrets/pass-admin" "$work/secrets/pass-admin.hidden"
  : > "$work/secrets/pass-admin"
  if ./deploy/backup/backup.sh; then echo 'expected Pass capture failure' >&2; exit 1; fi
  [ ! -e "$work/scratch/opensuite-backup.stale-fixture" ]
  [ "$(cat "$work/source/deploy/backup-status/last-failure")" = pass ]
  [ "$(stat -c %a "$work/source/deploy/backup-status/last-failure")" = 644 ]
  [ ! -e "$work/source/deploy/backup-status/last-success" ]
  services=$(compose ps --services --filter status=running)
  [ "$(printf '%s\n' "$services" | awk '$0 == "pass" {print}')" = pass ]
  cp "$work/secrets/pass-admin.hidden" "$work/secrets/pass-admin"
  rm "$work/secrets/pass-admin.hidden"
  compose restart pass
  case_done 'Pass capture failure alerts and restarts service'
}
pass_case_missing_key() {
  compose stop pass
  compose run --rm --no-deps -T backup-volumes 'mv /pass-data/rsa_key.pem /pass-data/rsa_key.hidden'
  if ./deploy/backup/backup.sh; then echo 'expected missing Pass key failure' >&2; exit 1; fi
  [ "$(cat "$work/source/deploy/backup-status/last-failure")" = pass ]
  [ "$(stat -c %a "$work/source/deploy/backup-status/last-failure")" = 644 ]
  services=$(compose ps --services --filter status=running)
  [ -z "$(printf '%s\n' "$services" | awk '$0 == "pass" {print}')" ]
  compose run --rm --no-deps -T backup-volumes 'mv /pass-data/rsa_key.hidden /pass-data/rsa_key.pem'
  compose start pass
  case_done 'stopped Pass and missing RSA key fail capture'
}
pass_case_backup() {
  [ ! -e "$work/source/deploy/backup-status/last-failure" ]
  case_done 'real encrypted backup and success marker'
}
pass_case_refusal() {
  mv .env "$work/target-env"
  if ./deploy/backup/restore.sh; then echo 'restore unexpectedly accepted a nonempty target' >&2; exit 1; fi
  mv "$work/target-env" .env
  case_done 'nonempty target refused'
}
pass_case_restore() {
  [ "$(docker run --rm --network none --mount "type=bind,src=$work/secrets/pass-admin,dst=/secret,readonly" alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a cat /secret)" = "$admin_hash" ]
  [ "$(compose exec -T postgres psql -U opensuite -d postgres -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_pass'")" = opensuite_pass ]
  [ "$(compose exec -T postgres psql -U opensuite -d postgres -Atc "SELECT has_database_privilege('opensuite_app','opensuite_pass','CONNECT')")" = f ]
  compose --profile pass up -d --no-deps --wait --wait-timeout 180 pass
  compose up -d --no-deps --wait --wait-timeout 180 caddy
  [ "$(compose exec -T pass id -u)" = 1000 ]
  [ "$(compose exec -T pass stat -c '%u:%g' /data/rsa_key.pem)" = 1000:1000 ]
  compose exec -T pass test -r /run/opensuite/pass-admin-token
  [ "$(compose exec -T pass sha256sum /data/rsa_key.pem | awk '{print $1}')" = "$rsa" ]
  case_done 'fresh database, secrets and identical RSA key'
}
pass_case_verify() {
  passport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  pass_client verify
  case_done 'login, decrypt item and download attachment'
}
pass_case_force_preflight() {
  compose stop caddy pass postgres
  if ./deploy/backup/restore.sh --force; then echo 'unconfirmed force unexpectedly accepted' >&2; exit 1; fi
  compose run --rm --no-deps -T backup-volumes 'printf sentinel > /pass-data/preflight-sentinel'
  printf 'conflicting-fixture' | rclone_local rcat store:drive-fixture/drive/objects/file-fixture
  if ./deploy/backup/restore.sh --force --confirm-project "$COMPOSE_PROJECT_NAME"; then echo 'conflicting object unexpectedly accepted' >&2; exit 1; fi
  compose run --rm --no-deps -T backup-volumes '[ "$(cat /pass-data/preflight-sentinel)" = sentinel ]'
  [ -s .env ]
  case_done 'force preflight protects local state'
}
pass_case_partial_restore() {
  printf 'drive-content-fixture' | rclone_local rcat store:drive-fixture/drive/objects/file-fixture
  rclone_local deletefile store:drive-fixture/drive/objects/file-fixture
  touch deploy/postgres/initdb/stale-fixture
  ./deploy/backup/restore.sh --force --confirm-project "$COMPOSE_PROJECT_NAME"
  [ ! -e deploy/postgres/initdb/stale-fixture ]
  [ "$(rclone_local cat store:drive-fixture/drive/objects/file-fixture)" = drive-content-fixture ]
  case_done 'partial object restore'
}
pass_case_retry() {
  compose --profile pass up -d --no-deps --wait --wait-timeout 180 pass
  compose up -d --no-deps --wait --wait-timeout 180 caddy
  passport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  rm -rf "$work/cli-verify"
  pass_client verify
  case_done 'explicit isolated restore retry'
}
