#!/usr/bin/env bash
# One-time setup: run Browser Bridge as a background login agent so it's always up
# (starts at login, restarts if it crashes). Downloads the PINNED Node runtime into
# ./runtime so there are NO prerequisites to install — you don't need Node yourself.
#
#   ./install.sh
#
# Uninstall any time with ./uninstall.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$DIR/bridge"
LABEL="com.aibrowserbridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME="$DIR/runtime"
NODE="$RUNTIME/node"

# Pinned Node version (single source of truth: runtime.json).
NODE_VER="$(grep -oE '"node"[[:space:]]*:[[:space:]]*"[^"]+"' "$DIR/runtime.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ -n "$NODE_VER" ] || { echo "❌ Could not read pinned Node version from runtime.json" >&2; exit 1; }

# Fetch + verify the pinned Node binary once (skipped if the right version is present).
need_node=1
if [ -x "$NODE" ] && "$NODE" --version 2>/dev/null | grep -q "v$NODE_VER"; then need_node=0; fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in arm64) NA=arm64;; x86_64) NA=x64;; *) echo "❌ Unsupported arch $(uname -m)" >&2; exit 1;; esac
  PKG="node-v$NODE_VER-darwin-$NA"
  URL="https://nodejs.org/dist/v$NODE_VER/$PKG.tar.gz"
  echo "Downloading pinned Node v$NODE_VER ($NA)…"
  mkdir -p "$RUNTIME"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$URL" -o "$TMP/node.tgz"
  # Verify against the official SHASUMS256.
  WANT="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt" | grep " $PKG.tar.gz\$" | awk '{print $1}')"
  GOT="$(shasum -a 256 "$TMP/node.tgz" | awk '{print $1}')"
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "❌ Node download failed checksum verification" >&2; exit 1; }
  tar xz -C "$RUNTIME" --strip-components=2 -f "$TMP/node.tgz" "$PKG/bin/node"
  echo "Installed runtime: $("$NODE" --version)"
fi

# Runtime deps: the release zip bundles `ws`. For a source checkout without it,
# fetch it with the bundled node's npm if available.
if [ ! -d "$BRIDGE/node_modules/ws" ]; then
  NPM="$RUNTIME/npm"; [ -x "$NPM" ] || NPM="$(command -v npm || true)"
  if [ -n "$NPM" ] && [ -x "$NPM" ]; then ( cd "$BRIDGE" && "$NPM" install --silent ); else
    echo "⚠️  bridge/node_modules/ws missing and no npm available — use a release zip (deps bundled)."; fi
fi

# Free the port if something is already on it.
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
  echo "✅ Bridge is running (bundled Node v$NODE_VER) and set to auto-start at login."
else
  echo "⚠️  Installed, but health check didn't respond yet. Check $BRIDGE/bridge.log"
fi

case "$DIR" in
  "$HOME/Downloads"/*|"$HOME/Documents"/*|"$HOME/Desktop"/*)
    echo ""
    echo "ℹ️  Tip: for a cleaner home, move this folder to ~/Applications/Browser Bridge and re-run ./install.sh."
    ;;
esac

echo ""
echo "   Dashboard: http://127.0.0.1:8787/"
echo "   Next: chrome://extensions → Load unpacked → select:"
echo "     $DIR/extension"
chmod +x "$DIR/Start Browser Bridge.command" "$DIR/Stop Browser Bridge.command" 2>/dev/null || true
open "$DIR/extension" 2>/dev/null || true
