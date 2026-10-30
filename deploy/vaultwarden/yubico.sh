#!/bin/sh
configure_yubico() {
  unset YUBICO_CLIENT_ID YUBICO_SECRET_KEY YUBICO_SECRET_KEY_FILE
  if [ -n "${VAULT_YUBICO_CLIENT_ID:-}" ]; then
    export YUBICO_CLIENT_ID="$VAULT_YUBICO_CLIENT_ID"
  fi
  if [ -s "$1" ]; then
    [ -z "${VAULT_YUBICO_SECRET_KEY:-}" ] || { echo 'Choose one Vault Yubico secret source' >&2; return 1; }
    export YUBICO_SECRET_KEY_FILE="$1"
  elif [ -n "${VAULT_YUBICO_SECRET_KEY:-}" ]; then
    export YUBICO_SECRET_KEY="$VAULT_YUBICO_SECRET_KEY"
  fi
}
