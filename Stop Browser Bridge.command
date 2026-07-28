#!/bin/bash
# Double-click to stop Browser Bridge completely (it will NOT restart until you
# double-click "Start Browser Bridge").
LABEL="com.browserbridge"
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
pkill -f "bridge/server.mjs" 2>/dev/null || true
echo "Browser Bridge stopped. Double-click 'Start Browser Bridge' to run it again."
