#!/bin/bash
# Agent Amusement Park — run automatically in the background (macOS)
# Double-click once. Starts now, and again every time you log in. Restarts itself if it stops.
cd "$(dirname "$0")"
DIR="$(pwd)"
LABEL="com.agentpark.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agent-amusement-park.log"

NODE="$(/bin/zsh -lc 'command -v node' 2>/dev/null)"
if [ -z "$NODE" ]; then
  echo "Node.js was not found. Install it from https://nodejs.org (LTS) and double-click this again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
GHDIR="$(dirname "$(/bin/zsh -lc 'command -v gh' 2>/dev/null || echo /opt/homebrew/bin/gh)")"

# stop any park that is already running by hand
lsof -ti :4321 | xargs kill 2>/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>NO_OPEN</key><string>1</string>
    <key>PATH</key><string>$(dirname "$NODE"):$GHDIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if curl -s -m 5 http://localhost:4321/api/state >/dev/null; then
  echo ""
  echo "  🎡  Agent Amusement Park now runs in the background."
  echo "      Your park:  http://localhost:4321"
  echo "      It starts by itself every time you log in. Log: $LOG"
  echo "      To turn it off: double-click uninstall-autostart.command"
  echo ""
  open http://localhost:4321
else
  echo "Something went wrong — here is the log:"; tail -20 "$LOG"
fi
read -n 1 -s -r -p "Press any key to close"
