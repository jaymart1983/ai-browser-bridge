#!/usr/bin/env bash
# One-time setup: run the Browser Bridge as a background login agent so it's
# always up (starts at login, restarts if it crashes). After this, you never
# manually start it — just load the extension and it connects.
#
#   ./install.sh
#
# Uninstall any time with ./uninstall.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$DIR/bridge"
LABEL="com.aibrowserbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "❌ Node.js not found in PATH. Install Node (https://nodejs.org) and re-run." >&2
  exit 1
fi
echo "Using node: $NODE"

echo "Installing bridge dependencies..."
( cd "$BRIDGE" && npm install --silent )

# Free the port if something (e.g. a manual 'npm start') is already on it.
lsof -ti:8787 | xargs kill -9 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$BRIDGE/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BRIDGE/bridge.log</string>
  <key>StandardErrorPath</key><string>$BRIDGE/bridge.log</string>
</dict></plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1

if curl -s http://127.0.0.1:8787/health >/dev/null 2>&1; then
  echo "✅ Bridge is running and set to auto-start at login."
else
  echo "⚠️  Installed, but health check didn't respond yet. Check $BRIDGE/bridge.log"
fi
echo "   Dashboard: http://127.0.0.1:8787/"
echo "   Next: load the extension folder in chrome://extensions (Load unpacked → $DIR/extension)"
