#!/usr/bin/env bash
set -euo pipefail

bin="${HOME}/.local/bin/bikri-print-agent"
plist="${HOME}/Library/LaunchAgents/com.algovyn.bikri.printagent.plist"

launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
rm -f "$plist" "$bin"
echo "Bikri Print Agent removed. Its config and logs under ${HOME}/Library/Application Support/BikriPrintAgent and ${HOME}/Library/Logs/BikriPrintAgent were kept."
