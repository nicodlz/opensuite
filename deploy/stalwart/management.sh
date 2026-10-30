#!/bin/sh
set -eu
# This helper has exactly one network: its address is the trusted client IP.
export STALWART_MANAGEMENT_CLIENT_IP="$(hostname -i | cut -d' ' -f1)"
export MAIL_RELAY_SECRET_FILE=/run/opensuite/smtp-secret
if [ "${1:-}" = apply ] && [ "${MAIL_RELAY_CONFIGURED:-0}" != 1 ]; then
  echo 'management: set MAIL_RELAY_CONFIGURED=1 and recreate Stalwart before applying' >&2
  exit 1
fi
if [ "${1:-}" = ingest ]; then
  exec node /app/scripts/ingest-credential.mjs "${2:?address required}" "${3:?account id required}"
fi
exec node /app/scripts/outbound.mjs "${1:?action required}" http://stalwart-management:8080 /run/opensuite/stalwart-management/password "${2:-}"
