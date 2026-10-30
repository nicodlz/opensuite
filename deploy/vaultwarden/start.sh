#!/bin/sh
set -eu
# The public vault must not share the application origin or an implicit port.
[ "$VAULT_HTTPS_PORT" = 443 ] || { echo 'Vault requires HTTPS_PORT=443.' >&2; exit 1; }
site=$(printf '%s' "$VAULT_MAIN_SITE_ADDRESS" | tr '[:upper:]' '[:lower:]')
site=${site#https://}; site=${site#http://}; site=${site%%/*}; site=${site%%:*}
vault_host=$(printf '%s' "$VAULT_PUBLIC_HOST" | tr '[:upper:]' '[:lower:]')
[ -n "$vault_host" ] && [ "$vault_host" != "$site" ] || { echo 'Vault requires a separate public hostname.' >&2; exit 1; }
# Saved admin settings override environment values. Fail closed on Unicode
# escapes, which could otherwise disguise the setting's name or value.
if [ -f /data/config.json ] && [ "$VAULT_ALLOW_SAVED_SIGNUPS" != true ]; then
  if ! perl -0777 -ne 'exit((/\\u[0-9a-fA-F]{4}/ || /"(?:signups_allowed|disable_admin_token)"\s*:\s*true\b/ || /"signups_domains_whitelist"\s*:\s*"[^"]/ || /"admin_token"\s*:\s*(?!null\b)/) ? 1 : 0)' /data/config.json; then
    echo 'Vault saved configuration contains a restricted setting; review it or explicitly allow saved settings.' >&2
    exit 1
  fi
fi
password=$(cat /run/opensuite/vault-database/password)
case "$password" in ''|*[!A-Za-z0-9]*) echo 'Invalid Vault database secret' >&2; exit 1;; esac
# The generated password is URL-safe. It never appears in Compose or argv.
export DATABASE_URL="postgresql://opensuite_vault:${password}@postgres:5432/opensuite_vault"
unset password
if [ -s /run/opensuite/vault-admin-token ]; then
  case "$(cat /run/opensuite/vault-admin-token)" in '$argon2id$'*|'$argon2i$'*|'$argon2d$'*) ;; *) echo 'Vault admin token must be an Argon2 PHC string' >&2; exit 1;; esac
  export ADMIN_TOKEN_FILE=/run/opensuite/vault-admin-token
fi
if [ -n "$VAULT_SMTP_HOST" ]; then
  [ -n "$VAULT_SMTP_FROM" ] || { echo 'Vault SMTP sender is required' >&2; exit 1; }
  export SMTP_HOST="$VAULT_SMTP_HOST" SMTP_FROM="$VAULT_SMTP_FROM" SMTP_PORT="$VAULT_SMTP_PORT" SMTP_SECURITY="$VAULT_SMTP_SECURITY"
  if [ -n "$VAULT_SMTP_USERNAME" ]; then
    [ -s /run/opensuite/vault-smtp-secret ] || { echo 'Vault SMTP secret is required' >&2; exit 1; }
    export SMTP_USERNAME="$VAULT_SMTP_USERNAME" SMTP_PASSWORD_FILE=/run/opensuite/vault-smtp-secret
  fi
fi
if [ "$VAULT_PUSH_ENABLED" = true ]; then
  [ -n "$VAULT_PUSH_INSTALLATION_ID" ] && [ -s /run/opensuite/vault-push-key ] || { echo 'Vault push credentials are required' >&2; exit 1; }
  export PUSH_ENABLED=true PUSH_INSTALLATION_ID="$VAULT_PUSH_INSTALLATION_ID" PUSH_INSTALLATION_KEY_FILE=/run/opensuite/vault-push-key
  export PUSH_RELAY_URI="$VAULT_PUSH_RELAY_URI" PUSH_IDENTITY_URI="$VAULT_PUSH_IDENTITY_URI"
fi
exec /start.sh
