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
umask 077
auth_dir="$(mktemp -d)"
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  rm -rf "$auth_dir"
  if [ "$result" -eq 0 ]; then status=ok; else status=failed; fi
  if [ -d /setup-status ]; then
    tmp="/setup-status/status.$$"
    if ! (umask 022; printf '%s\n' "$status" > "$tmp" && mv -f "$tmp" /setup-status/status); then
      echo 'stalwart-setup: could not record status' >&2
      result=1
    fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
password="$(cat "${STALWART_MANAGEMENT_PASSWORD_FILE:-/run/opensuite/stalwart-management/password}")"
case "$password" in *[!a-zA-Z0-9]*|'') echo 'stalwart-setup: invalid management password' >&2; exit 1 ;; esac
printf 'user = "management@opensuite.internal:%s"\n' "$password" >"$auth_dir/curl.conf"
# Stalwart rejects loopback X-Forwarded-For values; use this container's address.
self="$(hostname -i | cut -d' ' -f1)"

jmap() { # method calls as a JSON array
  curl -fsS -K "$auth_dir/curl.conf" -H "X-Forwarded-For: ${self}" \
    -H 'Content-Type: application/json' "${api}/jmap/" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":$1}"
}

fail_on_errors() {
  if printf '%s' "$1" | grep -qE '"notCreated"|"notUpdated"|\["error"'; then
    echo "stalwart-setup: API call failed: $1" >&2
    exit 1
  fi
}

# Only a restricted character set is accepted for JSON interpolated below.
# The secret itself is never sent over JMAP or stored in the registry.
safe_value() {
  case "$2" in
    *[!a-zA-Z0-9._:/-]*|'') echo "stalwart-setup: invalid or empty $1" >&2; exit 1 ;;
  esac
}

tracers="$(jmap '[["x:Tracer/get",{},"t"]]')"
fail_on_errors "$tracers"
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


# Share a certificate exported from Caddy. File references keep the private key
# out of JMAP and RocksDB; Stalwart reads them on settings reload/restart.
case "${MAIL_TLS_ENABLED:-0}" in
  0) ;;
  1)
    cert=/run/opensuite/tls/fullchain.pem
    key=/run/opensuite/tls/privkey.pem
    hostname="${MAIL_HOSTNAME:-localhost}"
    safe_value MAIL_HOSTNAME "$hostname"
    [ -s "$cert" ] && [ -s "$key" ] || { echo 'stalwart-setup: TLS certificate or key missing' >&2; exit 1; }
    openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null &&
      openssl x509 -in "$cert" -noout -checkhost "$hostname" | grep -Fq 'does match' || { echo 'stalwart-setup: certificate hostname or expiry invalid' >&2; exit 1; }
    cert_pub="$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)"
    key_pub="$(openssl pkey -in "$key" -pubout -outform DER | openssl dgst -sha256)"
    [ "$cert_pub" = "$key_pub" ] || { echo 'stalwart-setup: TLS certificate and key do not match' >&2; exit 1; }
    certificates="$(jmap '[["x:Certificate/get",{"properties":["id","certificate","privateKey"]},"c"]]')"
    fail_on_errors "$certificates"
    if ! printf '%s' "$certificates" | grep -Fq '"filePath":"/run/opensuite/tls/fullchain.pem"'; then
      result="$(jmap '[["x:Certificate/set",{"create":{"mail":{"certificate":{"@type":"File","filePath":"/run/opensuite/tls/fullchain.pem"},"privateKey":{"@type":"File","filePath":"/run/opensuite/tls/privkey.pem"}}}},"c"],["x:Action/set",{"create":{"reload":{"@type":"ReloadSettings"}}},"r"]]')"
      fail_on_errors "$result"
      echo 'stalwart-setup: certificate configured; restart Stalwart and verify TLS before publishing ports'
    fi
    ;;
  *) echo 'stalwart-setup: MAIL_TLS_ENABLED must be 0 or 1' >&2; exit 1 ;;
esac

blob="$(jmap '[["x:BlobStore/get",{"ids":["singleton"]},"b"]]')"
fail_on_errors "$blob"
changed=0
case "${MAIL_BLOB_STORE:-local}" in
  local)
    if ! printf '%s' "$blob" | grep -Fq '"@type":"Default"'; then
      echo 'stalwart-setup: existing blob store is not local; refusing to switch it' >&2
      exit 1
    fi
    ;;
  s3)
    safe_value MAIL_S3_ENDPOINT "${MAIL_S3_ENDPOINT:-}"
    safe_value MAIL_S3_REGION "${MAIL_S3_REGION:-}"
    safe_value MAIL_S3_BUCKET "${MAIL_S3_BUCKET:-}"
    safe_value MAIL_S3_KEY_ID "${MAIL_S3_KEY_ID:-}"
    [ -z "${MAIL_S3_PREFIX:-}" ] || safe_value MAIL_S3_PREFIX "$MAIL_S3_PREFIX"
    case "$MAIL_S3_ENDPOINT" in http://*|https://*) ;; *) echo 'stalwart-setup: endpoint must be an HTTP(S) URL' >&2; exit 1 ;; esac
    if [ ! -s /run/opensuite/mail-s3-secret ]; then
      echo 'stalwart-setup: S3 secret file is empty or missing' >&2
      exit 1
    fi
    prefix="${MAIL_S3_PREFIX:-}"
    if [ -z "$prefix" ]; then prefix_json=null; else prefix_json="\"${prefix}\""; fi
    matches_blob() {
      for field in '"@type":"S3"' "\"url\":\"${MAIL_S3_ENDPOINT}\"" \
        "\"region\":\"${MAIL_S3_REGION}\"" "\"bucket\":\"${MAIL_S3_BUCKET}\"" \
        "\"keyPrefix\":${prefix_json}" '"variableName":"MAIL_S3_KEY_ID"' \
        '"filePath":"/run/opensuite/mail-s3-secret"'; do
        printf '%s' "$1" | grep -Fq "$field" || return 1
      done
    }
    if ! matches_blob "$blob"; then
      if [ "${MAIL_S3_ALLOW_SWITCH:-0}" != 1 ]; then
        echo 'stalwart-setup: blob store differs; migrate existing blobs first and explicitly allow the switch' >&2
        exit 1
      fi
      result="$(jmap "[[\"x:BlobStore/set\",{\"update\":{\"singleton\":{\"@type\":\"S3\",\"region\":{\"@type\":\"Custom\",\"url\":\"${MAIL_S3_ENDPOINT}\",\"region\":\"${MAIL_S3_REGION}\"},\"bucket\":\"${MAIL_S3_BUCKET}\",\"keyPrefix\":${prefix_json},\"accessKeyId\":{\"@type\":\"EnvironmentVariable\",\"variableName\":\"MAIL_S3_KEY_ID\"},\"secretKey\":{\"@type\":\"File\",\"filePath\":\"/run/opensuite/mail-s3-secret\"}}}},\"b\"]]")"
      fail_on_errors "$result"
      saved="$(jmap '[["x:BlobStore/get",{"ids":["singleton"]},"b"]]')"
      fail_on_errors "$saved"
      matches_blob "$saved" || { echo 'stalwart-setup: saved blob settings do not match' >&2; exit 1; }
      changed=1
    fi
    ;;
  *) echo 'stalwart-setup: MAIL_BLOB_STORE must be local or s3' >&2; exit 1 ;;
esac


if [ "$changed" = 1 ]; then
  echo 'stalwart-setup: S3 configuration saved; restart Stalwart, then run setup again to probe storage'
elif [ "${MAIL_BLOB_STORE:-local}" = s3 ]; then
  # A unique upload and download exercises the active backend. The operator
  # must restart after a change before relying on this probe.
  session="$(curl -fsS -K "$auth_dir/curl.conf" -H "X-Forwarded-For: ${self}" "${api}/jmap/session")"
  account="$(printf '%s' "$session" | sed -n 's/.*"primaryAccounts":{"urn:ietf:params:jmap:mail":"\([a-zA-Z0-9]*\)".*/\1/p')"
  [ -n "$account" ] || { echo 'stalwart-setup: no admin mail account' >&2; exit 1; }
  probe="opensuite-storage-probe-$$-$(date +%s)"
  uploaded="$(printf '%s' "$probe" | curl -fsS -K "$auth_dir/curl.conf" -H "X-Forwarded-For: ${self}" -H 'Content-Type: application/octet-stream' --data-binary @- "${api}/jmap/upload/${account}/")"
  blob_id="$(printf '%s' "$uploaded" | sed -n 's/.*"blobId":"\([a-zA-Z0-9_-]*\)".*/\1/p')"
  [ -n "$blob_id" ] || { echo 'stalwart-setup: upload did not return a blob ID' >&2; exit 1; }
  readback="$(curl -fsS -K "$auth_dir/curl.conf" -H "X-Forwarded-For: ${self}" "${api}/jmap/download/${account}/${blob_id}/probe?accept=application%2Foctet-stream")"
  [ "$readback" = "$probe" ] || { echo 'stalwart-setup: storage probe bytes differ' >&2; exit 1; }
  echo 'stalwart-setup: active blob store upload/download succeeded'
fi
