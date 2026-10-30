#!/bin/sh
# Sourced by the integration harness; --list is the report's single case registry.
vault_drill_cases() {
  cat <<'CASES'
create user, encrypted item and attachment
Vault capture failure alerts and restarts service
stopped Vault and missing RSA key fail capture
real encrypted backup and success marker
nonempty target refused
fresh database, secrets and identical RSA key
login, decrypt item and download attachment
force preflight protects local state
partial object restore
explicit isolated restore retry
CASES
}
if [ "${1:-}" = --list ]; then vault_drill_cases; exit 0; fi
vault_client() { NODE_EXTRA_CA_CERTS="$work/caddy-ca" node "$root/test-support/vault-drill-client.mjs" "$1" "https://127.0.0.1:$vaultport" "$work"; }
vault_case_create() {
  compose --profile vault up -d --wait --wait-timeout 180 vault caddy
  vaultport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  vault_client create
  rsa=$(compose exec -T vault sha256sum /data/rsa_key.pem | awk '{print $1}')
  case_done 'create user, encrypted item and attachment'
}
vault_case_failure() {
  # A concurrent invocation must not publish a false failure marker.
  (
    flock -x 8
    if ./deploy/backup/backup.sh; then echo 'overlapping backup unexpectedly ran' >&2; exit 1; fi
    [ ! -e "$work/source/deploy/backup-status/last-failure" ]
  ) 8>"$work/scratch/opensuite-backup.lock"
  mkdir "$work/scratch/opensuite-backup.stale-fixture"
  printf stale > "$work/scratch/opensuite-backup.stale-fixture/data"
  # Simulate an enabled but unreadable data set; a failed capture must restart Vault
  # and publish a Vault-specific failure without refreshing the success marker.
  cp "$work/secrets/vault-admin" "$work/secrets/vault-admin.hidden"
  : > "$work/secrets/vault-admin"
  if ./deploy/backup/backup.sh; then echo 'expected Vault capture failure' >&2; exit 1; fi
  [ ! -e "$work/scratch/opensuite-backup.stale-fixture" ]
  [ "$(cat "$work/source/deploy/backup-status/last-failure")" = vault ]
  [ "$(stat -c %a "$work/source/deploy/backup-status/last-failure")" = 644 ]
  [ ! -e "$work/source/deploy/backup-status/last-success" ]
  services=$(compose ps --services --filter status=running)
  [ "$(printf '%s\n' "$services" | awk '$0 == "vault" {print}')" = vault ]
  cp "$work/secrets/vault-admin.hidden" "$work/secrets/vault-admin"
  rm "$work/secrets/vault-admin.hidden"
  compose restart vault
  case_done 'Vault capture failure alerts and restarts service'
}
vault_case_missing_key() {
  compose stop vault
  compose run --rm --no-deps -T backup-volumes 'mv /vault-data/rsa_key.pem /vault-data/rsa_key.hidden'
  if ./deploy/backup/backup.sh; then echo 'expected missing Vault key failure' >&2; exit 1; fi
  [ "$(cat "$work/source/deploy/backup-status/last-failure")" = vault ]
  [ "$(stat -c %a "$work/source/deploy/backup-status/last-failure")" = 644 ]
  services=$(compose ps --services --filter status=running)
  [ -z "$(printf '%s\n' "$services" | awk '$0 == "vault" {print}')" ]
  compose run --rm --no-deps -T backup-volumes 'mv /vault-data/rsa_key.hidden /vault-data/rsa_key.pem'
  compose start vault
  case_done 'stopped Vault and missing RSA key fail capture'
}
vault_case_backup() {
  [ ! -e "$work/source/deploy/backup-status/last-failure" ]
  case_done 'real encrypted backup and success marker'
}
vault_case_refusal() {
  mv .env "$work/target-env"
  if ./deploy/backup/restore.sh 2>"$work/refusal-stderr"; then echo 'restore unexpectedly accepted a nonempty target' >&2; exit 1; fi
  grep -Fq 'target volumes are not empty' "$work/refusal-stderr"
  mv "$work/target-env" .env
  case_done 'nonempty target refused'
}
vault_case_restore() {
  [ "$(docker run --rm --network none --mount "type=bind,src=$work/secrets/vault-admin,dst=/secret,readonly" alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a cat /secret)" = "$admin_hash" ]
  [ "$(compose exec -T postgres psql -U opensuite -d postgres -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='opensuite_vault'")" = opensuite_vault ]
  [ "$(compose exec -T postgres psql -U opensuite -d postgres -Atc "SELECT has_database_privilege('opensuite_app','opensuite_vault','CONNECT')")" = f ]
  compose --profile vault up -d --no-deps --wait --wait-timeout 180 vault
  compose up -d --no-deps --wait --wait-timeout 180 caddy
  [ "$(compose exec -T vault id -u)" = 1000 ]
  [ "$(compose exec -T vault stat -c '%u:%g' /data/rsa_key.pem)" = 1000:1000 ]
  compose exec -T vault test -r /run/opensuite/vault-admin-token
  [ "$(compose exec -T vault sha256sum /data/rsa_key.pem | awk '{print $1}')" = "$rsa" ]
  case_done 'fresh database, secrets and identical RSA key'
}
vault_case_verify() {
  vaultport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  vault_client verify
  case_done 'login, decrypt item and download attachment'
}
vault_case_force_preflight() {
  compose stop caddy vault postgres
  if ./deploy/backup/restore.sh --force; then echo 'unconfirmed force unexpectedly accepted' >&2; exit 1; fi
  if COMPOSE_PROJECT_NAME=opensuite ./deploy/backup/restore.sh --force --confirm-project opensuite 2>"$work/default-guard"; then echo 'default project unexpectedly accepted' >&2; exit 1; fi
  grep -Fq -- '--i-understand-this-is-production is required' "$work/default-guard"
  cp .env "$work/target-env"
  printf '\nCOMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME" >> .env
  if ./deploy/backup/restore.sh --force --confirm-project "$COMPOSE_PROJECT_NAME" 2>"$work/current-guard"; then echo 'configured project unexpectedly accepted' >&2; exit 1; fi
  grep -Fq -- '--i-understand-this-is-production is required' "$work/current-guard"
  compose run --rm --no-deps -T backup-volumes 'printf sentinel > /vault-data/preflight-sentinel'
  printf 'conflicting-fixture' | rclone_local rcat store:drive-fixture/drive/objects/file-fixture
  if ./deploy/backup/restore.sh --force --confirm-project "$COMPOSE_PROJECT_NAME" --i-understand-this-is-production; then echo 'conflicting object unexpectedly accepted' >&2; exit 1; fi
  compose run --rm --no-deps -T backup-volumes '[ "$(cat /vault-data/preflight-sentinel)" = sentinel ]'
  [ -s .env ]
  mv "$work/target-env" .env
  case_done 'force preflight protects local state'
}
vault_case_partial_restore() {
  printf 'drive-content-fixture' | rclone_local rcat store:drive-fixture/drive/objects/file-fixture
  rclone_local deletefile store:drive-fixture/drive/objects/file-fixture
  touch deploy/postgres/initdb/stale-fixture
  ./deploy/backup/restore.sh --force --confirm-project "$COMPOSE_PROJECT_NAME"
  [ ! -e deploy/postgres/initdb/stale-fixture ]
  [ "$(rclone_local cat store:drive-fixture/drive/objects/file-fixture)" = drive-content-fixture ]
  case_done 'partial object restore'
}
vault_case_retry() {
  compose --profile vault up -d --no-deps --wait --wait-timeout 180 vault
  compose up -d --no-deps --wait --wait-timeout 180 caddy
  vaultport=$(compose port caddy 443 | sed 's/.*://')
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$work/caddy-ca"
  rm -rf "$work/cli-verify"
  vault_client verify
  case_done 'explicit isolated restore retry'
}
