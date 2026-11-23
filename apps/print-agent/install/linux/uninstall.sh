#!/usr/bin/env bash
set -euo pipefail

bin="${HOME}/.local/bin/bikri-print-agent"
unit="${HOME}/.config/systemd/user/bikri-print-agent.service"
# os.UserConfigDir()/DefaultLogDir() paths the agent actually uses
# (docs/14-print-agent.md §12), including XDG overrides. The old
# BikriPrintAgent names never existed.
config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/bikri-print-agent"
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/bikri-print-agent"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop bikri-print-agent.service >/dev/null 2>&1 || true
  systemctl --user disable bikri-print-agent.service >/dev/null 2>&1 || true
fi
rm -f "$unit" "$bin"
# Remove the per-user config as well: leaving its token hash behind made a
# reinstall start "already paired" with a token the till no longer has.
rm -rf "$config_dir" "$state_dir"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
fi
echo "Bikri Print Agent removed, including its config and logs under ${config_dir} and ${state_dir}."
