#!/bin/sh
# One-shot, idempotent Stalwart settings applied through its JMAP management
# API once the server is healthy:
#   - log to stdout instead of the image's file target, whose directory is
#     missing;
#   - trust X-Forwarded-For from the reverse proxy (exactly one hop).
# Stalwart keeps these settings in its own store; ReloadSettings applies them
# without a restart.
set -eu

api="${STALWART_URL:-http://stalwart:8080}"
password="$(cat "${STALWART_ADMIN_PASSWORD_FILE:-/run/opensuite/stalwart-admin/password}")"
# Stalwart rejects loopback X-Forwarded-For values; use this container's address.
self="$(hostname -i | cut -d' ' -f1)"

jmap() { # method calls as a JSON array
  curl -fsS -u "admin:${password}" -H "X-Forwarded-For: ${self}" \
    -H 'Content-Type: application/json' "${api}/jmap/" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":$1}"
}

fail_on_errors() {
  if printf '%s' "$1" | grep -qE '"notCreated"|"notUpdated"|\["error"'; then
    echo "stalwart-setup: API call failed: $1" >&2
    exit 1
  fi
}

tracers="$(jmap '[["x:Tracer/get",{},"t"]]')"
# The image's default file tracer, which cannot write to its log directory.
log_ids="$(printf '%s' "$tracers" | grep -o '"@type":"Log","id":"[a-z0-9]*"' | sed 's/.*"id":"\([a-z0-9]*\)"/\1/' || true)"
updates=""
for id in $log_ids; do
  updates="${updates:+${updates},}\"${id}\":{\"enable\":false}"
done
create='{}'
if ! printf '%s' "$tracers" | grep -q '"@type":"Stdout"'; then
  create='{"stdout":{"@type":"Stdout","enable":true,"level":"info"}}'
fi

result="$(jmap "[[\"x:Tracer/set\",{\"create\":${create},\"update\":{${updates}}},\"t\"],
  [\"x:Http/set\",{\"update\":{\"singleton\":{\"clientIpSource\":\"xForwardedFor\",\"forwardedHops\":1}}},\"h\"],
  [\"x:Action/set\",{\"create\":{\"reload\":{\"@type\":\"ReloadSettings\"}}},\"r\"]]")"
fail_on_errors "$result"

# Verify by behaviour: with proxy trust active, a malformed header is refused.
status="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: not-an-address' "${api}/healthz/live")"
if [ "$status" != "400" ]; then
  echo "stalwart-setup: X-Forwarded-For trust not active (status ${status})" >&2
  exit 1
fi
echo "stalwart-setup: stdout logging and proxy trust applied"
