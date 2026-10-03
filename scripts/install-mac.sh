#!/bin/zsh
# Installs CardThief as a login agent: starts at login, restarts if it crashes,
# and keeps the Mac from idle-sleeping while it runs (closing the lid still sleeps it).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.ryan.cardthief.plist"
mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ryan.cardthief</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>$DIR/src/run.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$DIR/data/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/launchd.err.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.ryan.cardthief" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "CardThief installed and running. Logs: $DIR/data/cardthief.log"
echo "Stop:  launchctl bootout gui/$(id -u)/com.ryan.cardthief"
