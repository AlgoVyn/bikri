#!/usr/bin/env bash
set -euo pipefail

bin="${HOME}/.local/bin/bikri-print-agent"
unit="${HOME}/.config/systemd/user/bikri-print-agent.service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop bikri-print-agent.service >/dev/null 2>&1 || true
  systemctl --user disable bikri-print-agent.service >/dev/null 2>&1 || true
fi
rm -f "$unit" "$bin"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
fi
echo "Bikri Print Agent removed. The config and logs under ${HOME}/.config/BikriPrintAgent and ${HOME}/.local/state/BikriPrintAgent were kept."
