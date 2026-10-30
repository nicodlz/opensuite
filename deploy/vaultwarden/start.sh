#!/bin/sh
set -eu
password=$(cat /run/opensuite/pass-database/password)
case "$password" in ''|*[!A-Za-z0-9]*) echo 'Invalid Pass database secret' >&2; exit 1;; esac
# The generated password is URL-safe. It never appears in Compose or argv.
export DATABASE_URL="postgresql://opensuite_pass:${password}@postgres:5432/opensuite_pass"
unset password
if [ -s /run/opensuite/pass-admin-token ]; then
  case "$(cat /run/opensuite/pass-admin-token)" in '$argon2id$'*|'$argon2i$'*|'$argon2d$'*) ;; *) echo 'Pass admin token must be an Argon2 PHC string' >&2; exit 1;; esac
  export ADMIN_TOKEN_FILE=/run/opensuite/pass-admin-token
fi
if [ -n "$PASS_SMTP_HOST" ]; then
  [ -n "$PASS_SMTP_FROM" ] || { echo 'Pass SMTP sender is required' >&2; exit 1; }
  export SMTP_HOST="$PASS_SMTP_HOST" SMTP_FROM="$PASS_SMTP_FROM" SMTP_PORT="$PASS_SMTP_PORT" SMTP_SECURITY="$PASS_SMTP_SECURITY"
  if [ -n "$PASS_SMTP_USERNAME" ]; then
    [ -s /run/opensuite/pass-smtp-secret ] || { echo 'Pass SMTP secret is required' >&2; exit 1; }
    export SMTP_USERNAME="$PASS_SMTP_USERNAME" SMTP_PASSWORD_FILE=/run/opensuite/pass-smtp-secret
  fi
fi
if [ "$PASS_PUSH_ENABLED" = true ]; then
  [ -n "$PASS_PUSH_INSTALLATION_ID" ] && [ -s /run/opensuite/pass-push-key ] || { echo 'Pass push credentials are required' >&2; exit 1; }
  export PUSH_ENABLED=true PUSH_INSTALLATION_ID="$PASS_PUSH_INSTALLATION_ID" PUSH_INSTALLATION_KEY_FILE=/run/opensuite/pass-push-key
  export PUSH_RELAY_URI="$PASS_PUSH_RELAY_URI" PUSH_IDENTITY_URI="$PASS_PUSH_IDENTITY_URI"
fi
exec /start.sh
