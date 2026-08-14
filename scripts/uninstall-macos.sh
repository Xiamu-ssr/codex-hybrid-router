#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="${CODEX_ROUTER_CONFIG:-$CODEX_HOME/hybrid-router.json}"
CATALOG="${CODEX_MODEL_CATALOG:-$CODEX_HOME/model-catalog.json}"
LABEL="dev.codex-hybrid-router"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [[ -f "$CONFIG" && -f "$CATALOG" ]]; then
  CODEX_ROUTER_CONFIG="$CONFIG" CODEX_MODEL_CATALOG="$CATALOG" \
    node "$ROOT/update-model-catalog.mjs" --remove
fi

CODEX_ROUTER_PORT="${CODEX_ROUTER_PORT:-10100}" \
  node "$ROOT/scripts/patch-codex-config.mjs" --uninstall >/dev/null

print "Uninstalled. Restart Codex to return native GPT traffic to its original endpoint."
print "ChatGPT login, provider key, router config, logs, and backups were kept."
print "Optional cleanup paths are documented in README.md."
