#!/bin/zsh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer currently supports macOS only. The router itself is portable Node.js."
  exit 1
fi

ROOT="${0:A:h:h}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="${CODEX_ROUTER_CONFIG:-$CODEX_HOME/hybrid-router.json}"
LABEL="dev.codex-hybrid-router"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v node >/dev/null || { print -u2 "Node.js 22+ is required."; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 22 )) || { print -u2 "Node.js 22+ is required; found $(node -v)."; exit 1; }
[[ -f "$CODEX_HOME/auth.json" ]] || { print -u2 "Open Codex and sign in with ChatGPT once first."; exit 1; }
[[ -f "$CODEX_HOME/model-catalog.json" ]] || { print -u2 "Open Codex once so it creates $CODEX_HOME/model-catalog.json."; exit 1; }

cd "$ROOT"
npm ci
mkdir -p "$CODEX_HOME"
if [[ ! -f "$CONFIG" ]]; then
  cp "$ROOT/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG"
  print "Created $CONFIG"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$CODEX_HOME/model-catalog.json" "$CODEX_HOME/model-catalog.json.before-hybrid-router-$STAMP"
CODEX_ROUTER_CONFIG="$CONFIG" node "$ROOT/update-model-catalog.mjs"
CODEX_ROUTER_CONFIG="$CONFIG" node "$ROOT/scripts/patch-codex-config.mjs" >/dev/null
CODEX_ROUTER_CONFIG="$CONFIG" node "$ROOT/scripts/write-launch-agent.mjs" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
sleep 2
curl --max-time 5 -fsS "http://127.0.0.1:${CODEX_ROUTER_PORT:-10100}/healthz" >/dev/null

print "Installed and running. Restart Codex to refresh the model list."
print "If external models report a missing key, run: $ROOT/scripts/store-key-macos.sh"
