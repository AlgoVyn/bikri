#!/usr/bin/env bash
set -euo pipefail

bin="${HOME}/.local/bin/bikri-print-agent"
plist="${HOME}/Library/LaunchAgents/com.algovyn.bikri.printagent.plist"
# The paths the agent actually uses (docs/14-print-agent.md §12). The old
# BikriPrintAgent directory names never existed.
config_dir="${HOME}/Library/Application Support/bikri-print-agent"
log_dir="${HOME}/Library/Logs/BikriPrintAgent"

launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
rm -f "$plist" "$bin"
# Remove the per-user config as well: leaving its token hash behind made a
# reinstall start "already paired" with a token the till no longer has.
rm -rf "$config_dir" "$log_dir"
echo "Bikri Print Agent removed, including its config and logs under ${config_dir} and ${log_dir}."
