#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

bin_dir="${HOME}/.local/bin"
unit_dir="${HOME}/.config/systemd/user"
mkdir -p "$bin_dir" "$unit_dir"
install -m 0755 bikri-print-agent "$bin_dir/bikri-print-agent"
sed "s|%h/.local/bin/bikri-print-agent|${bin_dir}/bikri-print-agent|" \
  bikri-print-agent.service > "$unit_dir/bikri-print-agent.service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now bikri-print-agent.service
  echo "Bikri Print Agent installed and started."
else
  echo "Installed to ${bin_dir}/bikri-print-agent."
  echo "Start it manually: ${bin_dir}/bikri-print-agent"
fi
echo "Open http://127.0.0.1:17890/ to pair this computer with Bikri."
