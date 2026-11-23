#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

bin_dir="${HOME}/.local/bin"
agent="${bin_dir}/bikri-print-agent"
log_dir="${HOME}/Library/Logs/BikriPrintAgent"
plist="${HOME}/Library/LaunchAgents/com.algovyn.bikri.printagent.plist"
mkdir -p "$bin_dir" "$log_dir" "$(dirname "$plist")"
install -m 0755 bikri-print-agent "$agent"

# launchd writes the plist as XML. $HOME can contain &, < or quotes, which would
# produce an invalid plist and a silently unstarted agent.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}
agent_xml="$(xml_escape "$agent")"
# The agent writes JSON lines to agent.log itself (rotated at 5 MB with one
# backup). Pointing StandardErrorPath at a file duplicated every log line into an
# unrotated stderr.log that grew without bound; launchd has no log rotation.
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.algovyn.bikri.printagent</string>
  <key>ProgramArguments</key><array><string>${agent_xml}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
EOF

# launchd requires the job file to be owned by the user and not group/world
# writable; the heredoc honours the umask, which may be 0002 or 0000.
chmod 0644 "$plist"

# bootstrap/bootout replace the deprecated unload/load pair and reload an
# upgraded binary instead of leaving the old launchd job running.
launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Bikri Print Agent installed and started."
echo "Open http://127.0.0.1:17890/ to pair this computer with Bikri."
