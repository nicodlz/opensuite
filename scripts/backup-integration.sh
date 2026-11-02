#!/bin/sh
# Destructive only to uniquely named disposable containers, volumes and files.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d /tmp/opensuite-backup-test.XXXXXXXX)
name="osbackup$$"
old="$name-old"
new="$name-new"
object_store="$name-object-store"
object_network="$name-objects"
object_volume="$name-objects"
octet=$(( ($$ % 190) + 20 ))
test_subnet="10.238.$octet.0/24"
test_ip="10.238.$octet.10"
fixture_port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
rclone='rclone/rclone:1.71.2@sha256:3103526c506266a9ecdf064efe99bf3677d92ef6407af124d8c56b4f49cbaa51'
vault_drill=${VAULT_BACKUP_DRILL:-0}
. "$root/scripts/vault-drill.sh"
admin_hash='$argon2id$v=19$m=65536,t=3,p=4$ZGlzcG9zYWJsZS1zYWx0IQ$RsDLAAOjuY6ic36ncF+H4SzvxmYg8tdhdel1GSA9GTo'
case_done() { [ "$vault_drill" = 0 ] || printf '%s\n' "$1" >> "$VAULT_DRILL_CASES"; }
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ]; then
    for log_file in limited.log warning.log verify-failure.log prune-failure.log; do
      [ ! -f "$work/$log_file" ] || tail -40 "$work/$log_file" >&2
    done
  fi
  for project in "$old" "$new"; do
    if [ "$rc" -ne 0 ]; then docker compose --env-file "$work/source/.env" --project-name "$project" -f "$root/compose.yaml" logs --no-color postgres stalwart >&2 || :; fi
    docker compose --profile '*' --env-file "$work/source/.env" --project-name "$project" -f "$root/compose.yaml" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || :
    docker volume rm "${project}_secrets" "${project}_stalwart-data" "${project}_postgres-data" "${project}_vaultwarden-data" "${project}_caddy-data" "${project}_caddy-config" "${project}_setup-status" >/dev/null 2>&1 || :
    if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] || [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
      echo "cleanup: disposable project $project still has containers or volumes" >&2
      rc=1
    fi
  done
  docker rm -fv "$object_store" >/dev/null 2>&1 || :
  docker network rm "$object_network" >/dev/null 2>&1 || :
  docker volume rm "$object_volume" >/dev/null 2>&1 || :
  if [ -n "$(docker ps -aq --filter "name=^/$object_store$")" ] || [ -n "$(docker network ls -q --filter "name=^${object_network}$")" ] || [ -n "$(docker volume ls -q --filter "name=^${object_volume}$")" ]; then
    echo 'cleanup: disposable object store resources remain' >&2; rc=1
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$work/source/deploy" "$work/target/deploy" "$work/scratch" "$work/secrets"
chmod 755 "$work" "$work/secrets"
for folder in source target; do
  cp "$root/compose.yaml" "$work/$folder/compose.yaml"
  cp -R "$root/deploy/backup" "$root/deploy/stalwart" "$root/deploy/postgres" "$root/deploy/caddy" "$root/deploy/vaultwarden" "$work/$folder/deploy/"
  chmod -R a+rX "$work/$folder/deploy"
done
git -C "$work/source" init -q
git -C "$work/source" -c user.name=Fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture
docker network create "$object_network" >/dev/null
docker volume create "$object_volume" >/dev/null
docker run -d --name "$object_store" --network "$object_network" --network-alias object-store \
  -p 127.0.0.1::8333 -e AWS_ACCESS_KEY_ID=fixture-access -e AWS_SECRET_ACCESS_KEY=fixture-secret \
  -v "$object_volume:/data" \
  chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8 \
  server -ip.bind=0.0.0.0 -filer -s3 >/dev/null
port=$(docker port "$object_store" 8333/tcp | head -1 | sed 's/.*://')
tries=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" = 403 ]; do
  tries=$((tries + 1)); [ "$tries" -lt 60 ] || { echo 'object store did not become ready' >&2; exit 1; }; sleep 1
done
rclone_local() {
  docker run --rm -i --network host -e RCLONE_CONFIG_STORE_TYPE=s3 -e RCLONE_CONFIG_STORE_PROVIDER=Other \
    -e RCLONE_CONFIG_STORE_ACCESS_KEY_ID=fixture-access -e RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=fixture-secret \
    -e "RCLONE_CONFIG_STORE_ENDPOINT=http://127.0.0.1:$port" -e RCLONE_CONFIG_STORE_REGION=us-east-1 \
    "$rclone" "$@"
}
for bucket in backup-fixture mail-fixture drive-fixture; do rclone_local mkdir "store:$bucket"; done
printf 'fixture-repository-password\n' > "$work/secrets/restic"
printf 'fixture-secret' > "$work/secrets/mail"
printf 'fixture-secret' > "$work/secrets/drive"
printf 'relay-fixture' > "$work/secrets/relay"
printf 'tls-cert-fixture' > "$work/secrets/tls-cert"
printf 'tls-key-fixture' > "$work/secrets/tls-key"
printf 'INGEST_FIXTURE=present\n' > "$work/source/deploy/ingest.env"
printf 'OBSERVE_FIXTURE=present\n' > "$work/source/deploy/observe.env"
chmod 644 "$work/secrets/mail" "$work/secrets/drive" "$work/secrets/relay" "$work/secrets/tls-cert" "$work/secrets/tls-key"
cat > "$work/backup.conf" <<CONFIG
BACKUP_REPOSITORY='s3:http://object-store:8333/backup-fixture/repo'
BACKUP_REGION='us-east-1'
BACKUP_BUDGET_BYTES=1099511627776
BACKUP_KEEP_DAILY=1
BACKUP_KEEP_WEEKLY=0
BACKUP_KEEP_MONTHLY=0
BACKUP_ACCESS_KEY_ID='fixture-access'
BACKUP_SECRET_ACCESS_KEY='fixture-secret'
BACKUP_PASSWORD_FILE='$work/secrets/restic'
BACKUP_SCRATCH='$work/scratch'
CONFIG
# Expand the disposable paths, ports, and subnet into this fixture overlay.
cat > "$work/overlay.yaml" <<YAML
services:
  postgres:
    command: ["postgres", "-c", "fsync=off"]
    environment:
      POSTGRES_INITDB_ARGS: --no-sync
    healthcheck:
      start_period: 180s
      interval: 10s
      retries: 30
  stalwart:
    healthcheck:
      start_period: 180s
      retries: 30
    networks:
      objects:
    ports: !override ["127.0.0.1::8080"]
  backup-restic:
    networks: [objects]
  backup-stream:
    networks: [objects]
  backup-objects:
    networks: [objects]
    environment:
      RCLONE_RETRIES: "1"
      RCLONE_LOW_LEVEL_RETRIES: "1"
  vault:
    environment:
      SIGNUPS_ALLOWED: "true"
      DOMAIN: https://127.0.0.1:$fixture_port
    ports: !override ["127.0.0.1::8080"]
  caddy:
    entrypoint: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
    volumes: !override
      - $work/caddy-test:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    ports: !override ["127.0.0.1:$fixture_port:443"]
    networks:
      api-proxy:
        ipv4_address: 10.240.$octet.2
      pass-network:
        ipv4_address: 10.241.$octet.2
networks:
  objects:
    external: true
    name: $object_network
  api-proxy:
    ipam:
      config: !override
        - subnet: 10.240.$octet.0/24
  pass-network:
    ipam:
      config: !override
        - subnet: 10.241.$octet.0/24
          ip_range: 10.241.$octet.128/25
YAML
cat > "$work/caddy-test" <<'CADDY'
{
  default_sni 127.0.0.1
}
https://127.0.0.1 {
  tls internal
  reverse_proxy vault:8080
}
CADDY
cat > "$work/source/.env" <<CONFIG
POSTGRES_USER=opensuite
POSTGRES_DB=opensuite
POSTGRES_DRIVE_DB=opensuite_drive
VAULT_NETWORK_SUBNET=10.241.$octet.0/24
VAULT_NETWORK_IP_RANGE=10.241.$octet.128/25
VAULT_CADDY_IP=10.241.$octet.2
MAIL_MANAGEMENT_SUBNET=$test_subnet
MAIL_MANAGEMENT_API_IP=$test_ip
MAIL_MANAGEMENT_STALWART_IP=10.238.$octet.20
MAIL_MANAGEMENT_SETUP_IP=10.238.$octet.21
MAIL_MANAGEMENT_OPS_IP=10.238.$octet.22
MAIL_MANAGEMENT_BACKUP_IP=10.238.$octet.23
MAIL_MANAGEMENT_BOOTSTRAP_IP=10.238.$octet.24
API_PROXY_CADDY_IP=10.240.$octet.2
API_PROXY_API_IP=10.240.$octet.3
MAIL_BLOB_STORE=s3
MAIL_S3_ENDPOINT=http://object-store:8333
MAIL_S3_REGION=us-east-1
MAIL_S3_BUCKET=mail-fixture
MAIL_S3_PREFIX=mail/
MAIL_S3_KEY_ID=fixture-access
MAIL_S3_SECRET_FILE=$work/secrets/mail
MAIL_S3_ALLOW_SWITCH=1
MAIL_RELAY_SECRET_FILE=$work/secrets/relay
MAIL_TLS_CERT_FILE=$work/secrets/tls-cert
MAIL_TLS_KEY_FILE=$work/secrets/tls-key
DRIVE_S3_ENDPOINT=http://object-store:8333
DRIVE_S3_PUBLIC_ENDPOINT=http://object-store:8333
DRIVE_S3_REGION=us-east-1
DRIVE_S3_BUCKET=drive-fixture
DRIVE_S3_PREFIX=drive/
DRIVE_S3_ACCESS_KEY=fixture-access
DRIVE_S3_SECRET_FILE=$work/secrets/drive
OBSERVE_BACKUP_DIR=$work/source/deploy/backup-status
CONFIG
if [ "$vault_drill" = 1 ]; then
  printf '%s\n' "$admin_hash" > "$work/secrets/vault-admin"
  cat >> "$work/source/.env" <<CONFIG
VAULT_ADMIN_TOKEN_FILE=$work/secrets/vault-admin
VAULT_SIGNUPS_ALLOWED=true
CONFIG
fi
export BACKUP_CONFIG="$work/backup.conf" BACKUP_COMPOSE_OVERRIDE="$work/overlay.yaml" COMPOSE_PROJECT_NAME="$old" BACKUP_STAGE="$work/scratch"
set -a
. "$BACKUP_CONFIG"
set +a
cd "$work/source"
compose() { docker compose --project-name "$COMPOSE_PROJECT_NAME" -f compose.yaml -f deploy/backup/compose.backup.yaml -f "$work/overlay.yaml" "$@"; }
docker compose --project-name "$COMPOSE_PROJECT_NAME" -f compose.yaml -f deploy/backup/compose.backup.yaml -f deploy/stalwart/compose.bootstrap.yaml -f "$work/overlay.yaml" up -d --wait --wait-timeout 180 stalwart
docker compose --project-name "$COMPOSE_PROJECT_NAME" -f compose.yaml -f deploy/backup/compose.backup.yaml -f deploy/stalwart/compose.bootstrap.yaml -f "$work/overlay.yaml" --profile bootstrap run --rm stalwart-bootstrap
compose up -d --force-recreate --wait --wait-timeout 180 postgres stalwart
compose up --no-deps --force-recreate --exit-code-from stalwart-setup stalwart-setup
docker run --rm --network none -v "${old}_setup-status:/status:ro" \
  alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
  sh -ec '[ "$(cat /status/status)" = ok ]'
compose restart stalwart
compose up -d --wait --wait-timeout 180 stalwart
compose exec -T postgres psql -U opensuite -d opensuite -v ON_ERROR_STOP=1 < "$root/packages/db/prisma/migrations/20261029000000_initial/migration.sql"
compose exec -T postgres psql -U opensuite -d opensuite_drive -v ON_ERROR_STOP=1 < "$root/apps/drive/prisma/migrations/20261029000000_initial/migration.sql"
compose exec -T postgres psql -U opensuite -d opensuite -v ON_ERROR_STOP=1 -c 'INSERT INTO "User" (id, name, email, "updatedAt") VALUES ('"'"'fixture'"'"', '"'"'account-fixture'"'"', '"'"'fixture@example.invalid'"'"', now()); CREATE ROLE opensuite_app LOGIN; GRANT SELECT ON "User" TO opensuite_app;'
compose exec -T postgres psql -U opensuite -d opensuite_drive -v ON_ERROR_STOP=1 -c 'INSERT INTO "Entry" (id, "ownerId", name, kind, state, "objectKey", "updatedAt") VALUES ('"'"'file-fixture'"'"', '"'"'fixture'"'"', '"'"'file'"'"', '"'"'file'"'"', '"'"'ready'"'"', '"'"'drive/objects/file-fixture'"'"', now());'
printf 'drive-content-fixture' | rclone_local rcat store:drive-fixture/drive/objects/file-fixture
# Incompressible data demonstrates cross-snapshot deduplication, not compression.
dd if=/dev/urandom of="$work/large-object" bs=1048576 count=8 status=none
rclone_local rcat store:drive-fixture/drive/objects/large-fixture < "$work/large-object"
mailport=$(compose port stalwart 8080 | sed 's/.*://')
password=$(compose run --rm --no-deps -T backup-management 'cat /run/opensuite/stalwart-management/password')
base="http://127.0.0.1:$mailport"
request() { curl -fsS -u "management@opensuite.internal:$password" -H "X-Forwarded-For: $test_ip" "$@"; }
account=$(request "$base/jmap/session" | jq -er '.primaryAccounts["urn:ietf:params:jmap:mail"]')
jmap() { request -H 'Content-Type: application/json' -d "$1" "$base/jmap/"; }
inbox=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/get\",{\"accountId\":\"$account\"},\"a\"]]}" | jq -er '.methodResponses[0][1].list[] | select(.role == "inbox") | .id')
printf 'From: sender@example.invalid\r\nTo: recipient@example.invalid\r\nSubject: backup fixture\r\n\r\nmail-content-fixture\r\n' > "$work/message"
blob=$(request -H 'Content-Type: message/rfc822' --data-binary "@$work/message" "$base/jmap/upload/$account/" | jq -er .blobId)
response=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/import\",{\"accountId\":\"$account\",\"emails\":{\"fixture\":{\"blobId\":\"$blob\",\"mailboxIds\":{\"$inbox\":true}}}},\"a\"]]}")
email=$(printf '%s' "$response" | jq -er '.methodResponses[0][1].created.fixture.id')
[ "$vault_drill" = 0 ] || vault_case_create
./deploy/backup/init.sh
if [ "$vault_drill" = 1 ]; then vault_case_failure; vault_case_missing_key; fi
# An insufficient scratch reserve is refused before any service stops.
services=$(compose ps --services --filter status=running)
before=$(printf '%s\n' "$services" | sort)
if BACKUP_SCRATCH_RESERVE_BYTES=999999999999999999 ./deploy/backup/backup.sh 2>"$work/too-small"; then
  echo 'backup ran without enough scratch space' >&2; exit 1
fi
grep -q 'scratch too small' "$work/too-small"
services=$(compose ps --services --filter status=running)
[ "$(printf '%s\n' "$services" | sort)" = "$before" ]
[ ! -e "$work/source/deploy/backup-status/last-success" ]
./deploy/backup/backup.sh
[ -s "$work/source/deploy/backup-status/last-success" ]
[ "$(stat -c %a "$work/source/deploy/backup-status/last-success")" = 644 ]
[ "$(cat "$work/source/deploy/backup-status/last-failure")" = verification ]
# Maintenance cannot prune until an independent restore has been pinned.
if ./deploy/backup/retention.sh > "$work/no-pin.log" 2>&1; then
  echo 'retention ran without an independent restore pin' >&2; exit 1
fi
grep -q 'independent restore pin required' "$work/no-pin.log"
[ "$vault_drill" = 0 ] || case_done 'real encrypted backup and success marker'
first_bytes=$(compose run --rm --no-deps -T backup-restic 'exec restic stats --json --mode raw-data' | jq '.total_size')
# A budget already exhausted is refused before stopping any service.
cp "$work/backup.conf" "$work/limited-backup.conf"
printf '\nBACKUP_BUDGET_BYTES=1\n' >> "$work/limited-backup.conf"
if BACKUP_CONFIG="$work/limited-backup.conf" ./deploy/backup/backup.sh > "$work/limited.log" 2>&1; then
  echo 'backup ran with an exhausted repository budget' >&2; exit 1
fi
grep -q 'repository budget reached' "$work/limited.log"
services=$(compose ps --services --filter status=running)
[ "$(printf '%s\n' "$services" | sort)" = "$before" ]
# A low but not exhausted budget emits an early warning on a successful run.
cp "$work/backup.conf" "$work/warning-backup.conf"
printf '\nBACKUP_BUDGET_BYTES=1000000000\n' >> "$work/warning-backup.conf"
BACKUP_CONFIG="$work/warning-backup.conf" ./deploy/backup/backup.sh > "$work/warning.log" 2>&1
grep -q '"event":"storage_near_limit"' "$work/warning.log"
[ "$(cat "$work/source/deploy/backup-status/last-failure")" = capacity ]
[ -s "$work/source/deploy/backup-status/last-success" ]
second_bytes=$(compose run --rm --no-deps -T backup-restic 'exec restic stats --json --mode raw-data' | jq '.total_size')
[ "$((second_bytes - first_bytes))" -lt 4194304 ] || { echo 'unchanged object bytes were not deduplicated' >&2; exit 1; }
snapshot_count=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified' | jq 'length')
[ "$snapshot_count" -ge 2 ] || { echo 'backup removed the previous verified snapshot' >&2; exit 1; }
# A failed full readback after restart must not publish a verified snapshot.
mkdir "$work/fail-bin"
docker_path=$(command -v docker)
cat > "$work/fail-bin/docker" <<WRAPPER
#!/bin/sh
case "\$*" in
  *'backup-stream verify '*) echo 'fixture: injected object verification failure' >&2; exit 1;;
esac
exec "$docker_path" "\$@"
WRAPPER
chmod +x "$work/fail-bin/docker"
if PATH="$work/fail-bin:$PATH" ./deploy/backup/backup.sh > "$work/verify-failure.log" 2>&1; then
  echo 'backup ignored a failed snapshot verification' >&2; exit 1
fi
grep -q 'fixture: injected object verification failure' "$work/verify-failure.log"
grep -q '"event":"captured"' "$work/verify-failure.log"
grep -q '"event":"failure"' "$work/verify-failure.log"
services=$(compose ps --services --filter status=running)
[ "$(printf '%s\n' "$services" | sort)" = "$before" ]
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified' | jq 'length')" = "$snapshot_count" ]
pending_id=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-pending' | jq -er '.[0].id')
if ./deploy/backup/mark-restorable.sh "$pending_id" --confirm-restored "$pending_id" > "$work/pending-pin.log" 2>&1; then
  echo 'pending snapshot was accepted as restorable' >&2; exit 1
fi
# Independently restore a verified snapshot into a second disposable project.
# Both projects use the fixture object store; writers are stopped and the
# existing objects must match exactly before the isolated restore can proceed.
proof_id=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified --latest 1 --group-by paths' | jq -er '.[0].snapshots[0].id')
mkdir "$work/original-secrets"
for secret in mail drive relay tls-cert tls-key; do cp "$work/secrets/$secret" "$work/original-secrets/$secret"; done
if [ "$vault_drill" = 1 ]; then cp "$work/secrets/vault-admin" "$work/original-secrets/vault-admin"; fi
# Inspect scratch immediately after restic restores the metadata subtree. The
# object trees must stay in the repository and be streamed to their targets.
mkdir "$work/inspect-bin"
cat > "$work/inspect-bin/docker" <<WRAPPER
#!/bin/sh
case "\$*" in
  *'chown -R "\$1:\$2" /stage/data'*)
    "$docker_path" run --rm --network none --mount "type=bind,src=\$BACKUP_STAGE,dst=/stage,readonly" \
      alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a \
      sh -ec '[ ! -d /stage/data/objects/mail ] && [ ! -d /stage/data/objects/drive ]' || {
        echo 'restore staged object data in scratch' >&2; exit 1;
      }
    : > "$work/scratch-checked"
    ;;
esac
exec "$docker_path" "\$@"
WRAPPER
chmod +x "$work/inspect-bin/docker"
compose --profile '*' down --remove-orphans --timeout 10
(
  export COMPOSE_PROJECT_NAME="$new"
  cd "$work/target"
  PATH="$work/inspect-bin:$PATH" ./deploy/backup/restore.sh --force --confirm-project "$new" "$proof_id"
  [ -f "$work/scratch-checked" ] || { echo 'restore scratch inspection did not run' >&2; exit 1; }
  [ "$(compose exec -T postgres psql -U opensuite -d opensuite -Atc 'select name from "User"')" = account-fixture ]
  [ "$(compose exec -T postgres psql -U opensuite -d opensuite_drive -Atc 'select "objectKey" from "Entry"')" = drive/objects/file-fixture ]
  compose up -d --no-deps --wait --wait-timeout 180 stalwart
  mailport=$(compose port stalwart 8080 | sed 's/.*://')
  base="http://127.0.0.1:$mailport"
  response=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/get\",{\"accountId\":\"$account\",\"ids\":[\"$email\"],\"properties\":[\"id\",\"blobId\"]},\"a\"]]}")
  restored_blob=$(printf '%s' "$response" | jq -er '.methodResponses[0][1].list[0].blobId')
  request "$base/jmap/download/$account/$restored_blob/fixture.eml" > "$work/proof-message"
  cmp "$work/message" "$work/proof-message"
  rclone_local cat store:drive-fixture/drive/objects/large-fixture > "$work/proof-large"
  cmp "$work/large-object" "$work/proof-large"
  if [ "$vault_drill" = 1 ]; then vault_case_restore; vault_case_verify; fi
  compose --profile '*' down --volumes --remove-orphans --timeout 10
  rm .env deploy/ingest.env deploy/observe.env
)
for secret in mail drive relay tls-cert tls-key; do rm -f "$work/secrets/$secret"; cp "$work/original-secrets/$secret" "$work/secrets/$secret"; chmod 644 "$work/secrets/$secret"; done
if [ "$vault_drill" = 1 ]; then rm -f "$work/secrets/vault-admin"; cp "$work/original-secrets/vault-admin" "$work/secrets/vault-admin"; rm -rf "$work/cli-verify"; fi
# Recreate the one-shot dependencies as well: later compose start must find them.
compose up -d --no-deps secrets
compose up -d --no-deps --wait --wait-timeout 180 postgres stalwart
if [ "$vault_drill" = 1 ]; then
  compose --profile vault up --no-deps --exit-code-from vault-provision vault-provision
  compose --profile vault up -d --no-deps --wait --wait-timeout 180 vault caddy
fi
./deploy/backup/mark-restorable.sh "$proof_id" --confirm-restored "$proof_id" > "$work/restorable.log"
grep -q '"event":"snapshot_restorable"' "$work/restorable.log"
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-restorable' | jq 'length')" -ge 1 ]
old_pin=$(jq -er 'select(.event == "snapshot_restorable") | .snapshot' "$work/restorable.log")
unproven=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified' | jq -er --arg pinned "$old_pin" '[.[] | select(.id != $pinned)][0].id')
if ./deploy/backup/retire-restorable.sh "$old_pin" --confirm-replacement "$unproven" > "$work/unpin-refused.log" 2>&1; then
  echo 'last restorable pin was retired in favor of an unproven snapshot' >&2; exit 1
fi
grep -q 'both snapshots must be verified and pinned' "$work/unpin-refused.log"
if ./deploy/backup/retire-restorable.sh "$old_pin" --confirm-replacement "$old_pin" > "$work/unpin-self.log" 2>&1; then
  echo 'last restorable pin was retired without a replacement' >&2; exit 1
fi
# Create an older synthetic verified fixture so retention has an actual pack
# to forget and prune after the independently restored snapshot is pinned.
mkdir -p "$work/scratch/data"
dd if=/dev/urandom of="$work/scratch/data/old-fixture" bs=1048576 count=1 status=none
old_id=$(compose run --rm --no-deps -T backup-restic 'exec restic backup --json --time "2020-01-01 00:00:00" --tag opensuite-verified /stage/data' | jq -r 'select(.message_type == "summary") | .snapshot_id')
# A budget stop can be recovered by applying the same pinned policy manually.
BACKUP_CONFIG="$work/limited-backup.conf" ./deploy/backup/retention.sh > "$work/maintenance.log" 2>&1
grep -q '"event":"retention_maintenance_success"' "$work/maintenance.log"
snapshots=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified')
[ "$(printf '%s' "$snapshots" | jq --arg id "$old_id" '[.[] | select(.id == $id)] | length')" = 0 ]
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-restorable' | jq --arg id "$old_pin" '[.[] | select(.id == $id)] | length')" = 1 ]
# Recreate the obsolete fixture for the interrupted-prune recovery case.
old_id=$(compose run --rm --no-deps -T backup-restic 'exec restic backup --json --time "2020-01-01 00:00:00" --tag opensuite-verified /stage/data' | jq -r 'select(.message_type == "summary") | .snapshot_id')
rm -rf "$work/scratch/data"
# Interrupt prune after a newer snapshot has passed verification. Retention
# leaves at least two verified snapshots and the next run can resume pruning.
cat > "$work/fail-bin/docker" <<WRAPPER
#!/bin/bash
args=("\$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[\$i]}" == 'restic prune || '* ]]; then
    args[\$i]='mkfifo /stage/prune-fixture.pipe; restic prune > /stage/prune-fixture.pipe 2>&1 & p=\$!; while IFS= read -r line; do printf "%s\\n" "\$line" >&2; case "\$line" in *"loading all snapshots"*) kill -KILL "\$p" || exit 42; echo fixture-prune-killed >&2; break;; esac; done < /stage/prune-fixture.pipe; wait "\$p" 2>/dev/null; restic unlock; exit 43'
    echo 'fixture: interrupting prune' >&2
  fi
done
exec "$docker_path" "\${args[@]}"
WRAPPER
chmod +x "$work/fail-bin/docker"
if PATH="$work/fail-bin:$PATH" ./deploy/backup/backup.sh > "$work/prune-failure.log" 2>&1; then
  echo 'interrupted prune unexpectedly succeeded' >&2; exit 1
fi
grep -q 'fixture: interrupting prune' "$work/prune-failure.log"
grep -q 'fixture-prune-killed' "$work/prune-failure.log"
grep -q 'loading all snapshots' "$work/prune-failure.log"
grep -q 'successfully removed 1 locks' "$work/prune-failure.log"
grep -q '"event":"snapshot_verified"' "$work/prune-failure.log"
grep -q '"event":"failure"' "$work/prune-failure.log"
./deploy/backup/backup.sh
# The pinned recovery point and newer snapshots survive; the old fixture was forgotten.
snapshots=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified')
[ "$(printf '%s' "$snapshots" | jq --arg id "$old_id" '[.[] | select(.id == $id)] | length')" = 0 ]
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-restorable' | jq 'length')" -ge 1 ]
latest_after_prune=$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-verified --latest 1 --group-by paths' | jq -er '.[0].snapshots[0].id')
# Delete live application state and object copies while retaining the backup bucket.
compose --profile '*' down --volumes --remove-orphans --timeout 10
rclone_local purge store:mail-fixture/mail
rclone_local purge store:drive-fixture/drive
rm "$work/secrets/mail" "$work/secrets/drive" "$work/secrets/relay" "$work/secrets/tls-cert" "$work/secrets/tls-key"
if [ "$vault_drill" = 1 ]; then rm "$work/secrets/vault-admin"; rm -rf "$work/cli-create"; fi
export COMPOSE_PROJECT_NAME="$new"
cd "$work/target"
./deploy/backup/restore.sh "$latest_after_prune"
if [ "$vault_drill" = 1 ]; then
  vault_case_refusal; vault_case_restore; vault_case_verify
  vault_case_force_preflight; vault_case_partial_restore; vault_case_retry
fi
[ "$(cat deploy/ingest.env)" = INGEST_FIXTURE=present ]
[ "$(cat deploy/observe.env)" = OBSERVE_FIXTURE=present ]
for fixture in relay tls-cert tls-key; do
  [ "$(docker run --rm --network none --mount "type=bind,src=$work/secrets/$fixture,dst=/secret,readonly" alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a cat /secret)" = "$fixture-fixture" ]
done
compose up -d --no-deps --wait --wait-timeout 180 stalwart
[ "$(compose exec -T postgres psql -U opensuite -d opensuite -Atc 'select name from "User"')" = account-fixture ]
[ "$(compose exec -T postgres psql -U opensuite -d opensuite_drive -Atc 'select "objectKey" from "Entry"')" = drive/objects/file-fixture ]
[ "$(compose exec -T postgres psql -U opensuite -d opensuite -Atc "SELECT has_table_privilege('opensuite_app', '\"User\"', 'SELECT')")" = t ]
[ "$(rclone_local cat store:drive-fixture/drive/objects/file-fixture)" = drive-content-fixture ]
rclone_local cat store:drive-fixture/drive/objects/large-fixture > "$work/restored-large"
cmp "$work/large-object" "$work/restored-large"
mailport=$(compose port stalwart 8080 | sed 's/.*://')
base="http://127.0.0.1:$mailport"
response=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/get\",{\"accountId\":\"$account\",\"ids\":[\"$email\"],\"properties\":[\"id\",\"blobId\"]},\"a\"]]}")
restored_blob=$(printf '%s' "$response" | jq -er '.methodResponses[0][1].list[0].blobId')
request "$base/jmap/download/$account/$restored_blob/fixture.eml" > "$work/restored-message"
cmp "$work/message" "$work/restored-message"
# The just-restored newer snapshot can replace the older independent proof.
./deploy/backup/mark-restorable.sh "$latest_after_prune" --confirm-restored "$latest_after_prune" > "$work/new-restorable.log"
new_pin=$(jq -er 'select(.event == "snapshot_restorable") | .snapshot' "$work/new-restorable.log")
./deploy/backup/retire-restorable.sh "$old_pin" --confirm-replacement "$new_pin" > "$work/unpinned.log"
grep -q '"event":"snapshot_unpinned"' "$work/unpinned.log"
BACKUP_CONFIG="$work/limited-backup.conf" ./deploy/backup/retention.sh > "$work/final-maintenance.log" 2>&1
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-restorable' | jq --arg id "$new_pin" '[.[] | select(.id == $id)] | length')" = 1 ]
[ "$(compose run --rm --no-deps -T backup-restic 'exec restic snapshots --json --tag opensuite-restorable' | jq 'length')" = 1 ]
printf '%s\n' 'Backup integration passed: PostgreSQL accounts and Drive metadata, Drive object, Stalwart account and S3 mail bytes restored.'
