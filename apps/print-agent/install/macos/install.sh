#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

bin_dir="${HOME}/.local/bin"
agent="${bin_dir}/bikri-print-agent"
log_dir="${HOME}/Library/Logs/BikriPrintAgent"
plist="${HOME}/Library/LaunchAgents/com.algovyn.bikri.printagent.plist"
mkdir -p "$bin_dir" "$log_dir" "$(dirname "$plist")"
install -m 0755 bikri-print-agent "$agent"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.algovyn.bikri.printagent</string>
  <key>ProgramArguments</key><array><string>${agent}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${log_dir}/stderr.log</string>
  <key>StandardOutPath</key><string>${log_dir}/stdout.log</string>
</dict>
</plist>
EOF

# bootstrap/bootout replace the deprecated unload/load pair and reload an
# upgraded binary instead of leaving the old launchd job running.
launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Bikri Print Agent installed and started."
echo "Open http://127.0.0.1:17890/ to pair this computer with Bikri."
