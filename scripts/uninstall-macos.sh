#!/bin/zsh

set -euo pipefail

LABEL="dev.codex-hybrid-router"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"
print "Router service removed."
print "Codex config and catalog were left intact to avoid overwriting later user changes."
print "Restore the desired *.before-hybrid-router-* backups under ~/.codex, then restart Codex."
