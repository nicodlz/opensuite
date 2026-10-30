#!/bin/sh
# Run only against a server temporarily started with the recovery credential.
set -eu
api="${STALWART_URL:-http://stalwart:8080}"
subnet="${MAIL_MANAGEMENT_SUBNET:-172.30.248.0/24}"
case "$subnet" in *[!0-9./]*|'') echo 'invalid management subnet' >&2; exit 1 ;; esac
password="$(cat /run/opensuite/stalwart-management/password)"
case "$password" in *[!a-zA-Z0-9]*|'') echo 'invalid management password' >&2; exit 1 ;; esac
self="$(hostname -i | cut -d' ' -f1)"
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
printf 'user = "admin:%s"\n' "$(cat /run/opensuite/stalwart-admin/password)" >"$tmp/recovery"
printf 'user = "management@opensuite.internal:%s"\n' "$password" >"$tmp/management"
jmap() {
  curl -fsS -K "$1" -H "X-Forwarded-For: ${self}" -H 'Content-Type: application/json' \
    --data-binary "@$tmp/request" "${api}/jmap/"
}
request() { printf '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":%s}' "$1" >"$tmp/request"; }
request '[["x:Domain/query",{},"q"]]'
if jmap "$tmp/management" >"$tmp/check" 2>/dev/null && grep -q '"x:Domain/query"' "$tmp/check"; then
  echo 'management credential already works; no changes made'
  exit 0
fi
# Refuse to take over an existing identity; recovery must be deliberate.
request '[["x:Domain/set",{"create":{"domain":{"name":"opensuite.internal","dkimManagement":{"@type":"Manual"}}}},"d"]]'
result="$(jmap "$tmp/recovery")"
id="$(printf '%s' "$result" | sed -n 's/.*"created":{"domain":{"id":"\([a-zA-Z0-9]*\)".*/\1/p')"
[ -n "$id" ] || { echo 'bootstrap: management domain exists or could not be created; resolve manually' >&2; exit 1; }
request "[[\"x:Account/set\",{\"create\":{\"account\":{\"@type\":\"User\",\"name\":\"management\",\"domainId\":\"${id}\",\"roles\":{\"@type\":\"Admin\"},\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"${password}\",\"allowedIps\":{\"${subnet}\":true}}}}}},\"a\"]]"
result="$(jmap "$tmp/recovery")"
printf '%s' "$result" | grep -q '"created":{"account":{"id":' || { echo 'bootstrap: account creation failed' >&2; exit 1; }
request '[["x:Domain/query",{},"q"]]'
jmap "$tmp/management" >"$tmp/check"
grep -q '"x:Domain/query"' "$tmp/check" || { echo 'bootstrap: management verification failed' >&2; exit 1; }
echo 'management account created and verified; remove recovery override and recreate Stalwart'
