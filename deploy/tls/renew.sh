#!/bin/sh
# Run as root from the timer; the checkout and .env are trusted.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
[ -r .env ] || { echo 'tls: missing .env' >&2; exit 1; }
set -a
. ./.env
set +a
: "${MAIL_HOSTNAME:?}" "${MAIL_TLS_CERT_FILE:?}" "${MAIL_TLS_KEY_FILE:?}"
case "$MAIL_HOSTNAME" in *[!a-zA-Z0-9.-]*|'') echo 'tls: invalid hostname' >&2; exit 1;; esac
case "$MAIL_TLS_CERT_FILE:$MAIL_TLS_KEY_FILE" in */dev/null*) echo 'tls: configure certificate paths' >&2; exit 1;; esac
# Once backups are configured, share their lock to keep the TLS pair stable
# throughout a snapshot. Initial certificate provisioning can precede backups.
if [ -r /etc/opensuite/backup.conf ]; then
  . /etc/opensuite/backup.conf
  : "${BACKUP_SCRATCH:?}"
  exec 8>"$BACKUP_SCRATCH/opensuite-backup.lock"
  flock -n 8 || { echo 'tls: backup or replay is running' >&2; exit 1; }
fi
exec 9>/run/lock/opensuite-tls.lock
flock -n 9 || { echo 'tls: renewal already running' >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
# Caddy stores a pair named after the site in its issuer/hostname directory.
paths=$(docker compose exec -T caddy find /data/caddy/certificates -type f -name "$MAIL_HOSTNAME.crt")
[ "$(printf '%s\n' "$paths" | wc -l)" -eq 1 ] && [ -n "$paths" ] || { echo 'tls: expected exactly one Caddy certificate' >&2; exit 1; }
base=${paths%.crt}
docker compose cp "caddy:$base.crt" "$tmp/cert"
docker compose cp "caddy:$base.key" "$tmp/key"
openssl x509 -in "$tmp/cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$tmp/cert" -noout -checkhost "$MAIL_HOSTNAME" | grep -Fq 'does match'
cert_pub=$(openssl x509 -in "$tmp/cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
key_pub=$(openssl pkey -in "$tmp/key" -pubout -outform DER | openssl dgst -sha256)
[ "$cert_pub" = "$key_pub" ] || { echo 'tls: certificate and key do not match' >&2; exit 1; }
mkdir -p "$(dirname "$MAIL_TLS_CERT_FILE")" "$(dirname "$MAIL_TLS_KEY_FILE")"
pending="$(dirname "$MAIL_TLS_CERT_FILE")/.renew-pending"
if ! cmp -s "$tmp/cert" "$MAIL_TLS_CERT_FILE" || ! cmp -s "$tmp/key" "$MAIL_TLS_KEY_FILE"; then
  touch "$pending"
  # Rename in each destination filesystem; recreate Stalwart to refresh file binds.
  for pair in "cert:$MAIL_TLS_CERT_FILE" "key:$MAIL_TLS_KEY_FILE"; do
    src=${pair%%:*}; dest=${pair#*:}
    next=$(mktemp "${dest}.XXXXXXXX")
    cp "$tmp/$src" "$next"
    chown 2000:2000 "$next"
    chmod 0400 "$next"
    mv -f "$next" "$dest"
  done
fi
if [ -e "$pending" ]; then
  docker compose up -d --no-deps --force-recreate --wait stalwart
  rm -f "$pending"
  echo 'tls: installed Caddy certificate and recreated Stalwart'
fi
