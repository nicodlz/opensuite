#!/bin/sh
# Destructive only to uniquely named disposable containers, volumes and files.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d /tmp/opensuite-backup-test.XXXXXXXX)
name="osbackup$$"
old="$name-old"
new="$name-new"
minio="$name-minio"
octet=$(( ($$ % 190) + 20 ))
test_subnet="10.238.$octet.0/24"
test_ip="10.238.$octet.10"
fixture_port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
rclone='rclone/rclone:1.71.2@sha256:3103526c506266a9ecdf064efe99bf3677d92ef6407af124d8c56b4f49cbaa51'
pass_drill=${PASS_BACKUP_DRILL:-0}
. "$root/scripts/pass-drill.sh"
admin_hash='$argon2id$v=19$m=65536,t=3,p=4$ZGlzcG9zYWJsZS1zYWx0IQ$RsDLAAOjuY6ic36ncF+H4SzvxmYg8tdhdel1GSA9GTo'
case_done() { [ "$pass_drill" = 0 ] || printf '%s\n' "$1" >> "$PASS_DRILL_CASES"; }
cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  for project in "$old" "$new"; do
    if [ "$rc" -ne 0 ]; then docker compose --env-file "$work/source/.env" --project-name "$project" -f "$root/compose.yaml" logs --no-color postgres stalwart >&2 || :; fi
    docker compose --profile '*' --env-file "$work/source/.env" --project-name "$project" -f "$root/compose.yaml" down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || :
    docker volume rm "${project}_secrets" "${project}_stalwart-data" "${project}_postgres-data" "${project}_vaultwarden-data" "${project}_caddy-data" "${project}_caddy-config" "${project}_setup-status" >/dev/null 2>&1 || :
    if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] || [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
      echo "cleanup: disposable project $project still has containers or volumes" >&2
      rc=1
    fi
  done
  docker rm -fv "$minio" >/dev/null 2>&1 || :
  if [ -n "$(docker ps -aq --filter "name=^/$minio$")" ]; then echo 'cleanup: disposable object store remains' >&2; rc=1; fi
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
docker run -d --name "$minio" -p 0.0.0.0::9000 -e MINIO_ROOT_USER=fixture-access -e MINIO_ROOT_PASSWORD=fixture-secret \
  minio/minio:RELEASE.2025-07-23T15-54-02Z@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0 server /data >/dev/null
port=$(docker port "$minio" 9000/tcp | head -1 | sed 's/.*://')
tries=0
until curl -fsS "http://127.0.0.1:$port/minio/health/ready" >/dev/null; do
  tries=$((tries + 1)); [ "$tries" -lt 60 ] || exit 1; sleep 1
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
BACKUP_REPOSITORY='s3:http://host.docker.internal:$port/backup-fixture/repo'
BACKUP_REGION='us-east-1'
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
    extra_hosts: ["host.docker.internal:host-gateway"]
    ports: !override ["127.0.0.1::8080"]
  stalwart-setup:
    extra_hosts: ["host.docker.internal:host-gateway"]
  backup-restic:
    extra_hosts: ["host.docker.internal:host-gateway"]
  backup-objects:
    extra_hosts: ["host.docker.internal:host-gateway"]
  pass:
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
  reverse_proxy pass-vault:8080
}
CADDY
cat > "$work/source/.env" <<CONFIG
POSTGRES_USER=opensuite
POSTGRES_DB=opensuite
POSTGRES_DRIVE_DB=opensuite_drive
PASS_NETWORK_SUBNET=10.241.$octet.0/24
PASS_NETWORK_IP_RANGE=10.241.$octet.128/25
PASS_CADDY_IP=10.241.$octet.2
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
MAIL_S3_ENDPOINT=http://host.docker.internal:$port
MAIL_S3_REGION=us-east-1
MAIL_S3_BUCKET=mail-fixture
MAIL_S3_PREFIX=mail/
MAIL_S3_KEY_ID=fixture-access
MAIL_S3_SECRET_FILE=$work/secrets/mail
MAIL_S3_ALLOW_SWITCH=1
MAIL_RELAY_SECRET_FILE=$work/secrets/relay
MAIL_TLS_CERT_FILE=$work/secrets/tls-cert
MAIL_TLS_KEY_FILE=$work/secrets/tls-key
DRIVE_S3_ENDPOINT=http://host.docker.internal:$port
DRIVE_S3_PUBLIC_ENDPOINT=http://host.docker.internal:$port
DRIVE_S3_REGION=us-east-1
DRIVE_S3_BUCKET=drive-fixture
DRIVE_S3_PREFIX=drive/
DRIVE_S3_ACCESS_KEY=fixture-access
DRIVE_S3_SECRET_FILE=$work/secrets/drive
OBSERVE_BACKUP_DIR=$work/source/deploy/backup-status
CONFIG
if [ "$pass_drill" = 1 ]; then
  printf '%s\n' "$admin_hash" > "$work/secrets/pass-admin"
  cat >> "$work/source/.env" <<CONFIG
PASS_ADMIN_TOKEN_FILE=$work/secrets/pass-admin
PASS_SIGNUPS_ALLOWED=true
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
[ "$pass_drill" = 0 ] || pass_case_create
./deploy/backup/init.sh
if [ "$pass_drill" = 1 ]; then pass_case_failure; pass_case_missing_key; fi
# A scratch area too small for the objects is refused before any service stops.
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
[ "$pass_drill" = 0 ] || pass_case_backup
# Delete live application state and object copies while retaining the backup bucket.
compose --profile '*' down --volumes --remove-orphans --timeout 10
rclone_local purge store:mail-fixture/mail
rclone_local purge store:drive-fixture/drive
rm "$work/secrets/mail" "$work/secrets/drive" "$work/secrets/relay" "$work/secrets/tls-cert" "$work/secrets/tls-key"
if [ "$pass_drill" = 1 ]; then rm "$work/secrets/pass-admin"; rm -rf "$work/cli-create"; fi
export COMPOSE_PROJECT_NAME="$new"
cd "$work/target"
./deploy/backup/restore.sh
if [ "$pass_drill" = 1 ]; then
  pass_case_refusal; pass_case_restore; pass_case_verify
  pass_case_force_preflight; pass_case_partial_restore; pass_case_retry
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
mailport=$(compose port stalwart 8080 | sed 's/.*://')
base="http://127.0.0.1:$mailport"
response=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/get\",{\"accountId\":\"$account\",\"ids\":[\"$email\"],\"properties\":[\"id\",\"blobId\"]},\"a\"]]}")
restored_blob=$(printf '%s' "$response" | jq -er '.methodResponses[0][1].list[0].blobId')
request "$base/jmap/download/$account/$restored_blob/fixture.eml" > "$work/restored-message"
cmp "$work/message" "$work/restored-message"
printf '%s\n' 'Backup integration passed: PostgreSQL accounts and Drive metadata, Drive object, Stalwart account and S3 mail bytes restored.'
