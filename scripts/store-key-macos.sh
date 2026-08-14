#!/bin/zsh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This helper uses macOS Keychain. On other systems, set the configured API-key environment variable."
  exit 1
fi

ROOT="${0:A:h:h}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="${CODEX_ROUTER_CONFIG:-$CODEX_HOME/hybrid-router.json}"
SERVICE="$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(c.external_provider.keychain_service||"")' "$CONFIG")"
ACCOUNT="$(node -e 'const fs=require("fs"),os=require("os"); const c=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(c.external_provider.keychain_account||os.userInfo().username)' "$CONFIG")"

if [[ -z "$SERVICE" ]]; then
  print -u2 "external_provider.keychain_service is empty in $CONFIG"
  exit 1
fi

read -r -s "API_KEY?External provider API key: "
print
if [[ -z "$API_KEY" ]]; then
  print -u2 "No key entered."
  exit 1
fi
/usr/bin/security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" -w "$API_KEY" >/dev/null
unset API_KEY
print "Stored the key in macOS Keychain service: $SERVICE"
