#!/bin/bash
# Double-click to start Browser Bridge (and re-enable auto-start at login).
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.aibrowserbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ ! -f "$PLIST" ]; then
  # First run or never installed → do a full install (downloads the pinned Node).
  exec "$DIR/install.sh"
fi
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true      # clear any half-loaded state
launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
sleep 1
if curl -s http://127.0.0.1:8787/health >/dev/null 2>&1; then
  echo "Browser Bridge started."
  open "http://127.0.0.1:8787/"
else
  echo "Started the agent, but the bridge didn't answer yet. Log: $DIR/bridge/bridge.log"
fi
