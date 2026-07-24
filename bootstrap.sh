#!/usr/bin/env bash
# Browser Bridge — one-command installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.sh | bash
#
# Creates ~/Applications/Browser Bridge, downloads the latest release into it,
# then runs install.sh (which fetches the pinned Node runtime, registers the
# launchd agent, and starts the bridge). No prerequisites — not even Node.
set -e

REPO="jaymart1983/browser-bridge"
TARGET="$HOME/Applications/Browser Bridge"

echo "Browser Bridge installer"
echo "  target: $TARGET"

# Resolve the latest macOS release asset via the public GitHub API (no jq needed).
API="https://api.github.com/repos/$REPO/releases/latest"
URL="$(curl -fsSL "$API" | grep -oE '"browser_download_url":[[:space:]]*"[^"]*macos[^"]*\.zip"' | head -1 | grep -oE 'https://[^"]*')"
[ -n "$URL" ] || { echo "❌ Could not find a macOS release asset. See $API" >&2; exit 1; }
echo "  downloading: $URL"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/bb.zip"
unzip -q "$TMP/bb.zip" -d "$TMP/x"

# Overlay the app files into the target. State, recordings, and the downloaded Node
# runtime aren't in the zip, so a re-run preserves them (same as an in-app update).
mkdir -p "$TARGET"
cp -R "$TMP/x/browser-bridge/." "$TARGET/"
chmod +x "$TARGET/install.sh" "$TARGET/Start Browser Bridge.command" "$TARGET/Stop Browser Bridge.command" 2>/dev/null || true

echo "  installed files; running install.sh…"
cd "$TARGET"
./install.sh
