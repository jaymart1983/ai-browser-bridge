#!/usr/bin/env bash
# Remove the AI Browser Bridge login agent (stops auto-start and the running bridge).
set -e
LABEL="com.aibrowserbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
lsof -ti:8787 | xargs kill -9 2>/dev/null || true
echo "✅ Bridge login agent removed and stopped."
