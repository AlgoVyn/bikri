#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

bin_dir="${HOME}/.local/bin"
agent="${bin_dir}/bikri-print-agent"
plist="${HOME}/Library/LaunchAgents/com.algovyn.bikri.printagent.plist"
mkdir -p "$bin_dir" "$(dirname "$plist")"
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
</dict>
</plist>
EOF

launchctl unload "$plist" >/dev/null 2>&1 || true
launchctl load "$plist"
echo "Bikri Print Agent installed and started."
echo "Open http://127.0.0.1:17890/ to pair this computer with Bikri."
