#!/usr/bin/env bash
# Clean Browser Bridge.command — completely remove Browser Bridge from this Mac
# (service + install folders) so you can test a fresh install.
#
# SAFETY: it NEVER deletes a source checkout. Any Browser Bridge folder that
# contains a .git directory is treated as the code repo and skipped, and it only
# removes folders under your home that actually look like an install.
set -u

# Both the current label and the old one (renamed from com.aibrowserbridge).
LABELS="com.browserbridge com.aibrowserbridge"
UID_="$(id -u)"

echo "== Clean Browser Bridge =="

# Where do the launchd services point? (read before we delete the plists)
INSTALL_FROM_PLIST=""
for L in $LABELS; do
  P="$HOME/Library/LaunchAgents/$L.plist"
  if [ -f "$P" ] && [ -z "$INSTALL_FROM_PLIST" ]; then
    SERVER="$(grep 'server\.mjs' "$P" | sed -E 's:.*<string>([^<]*)</string>.*:\1:' | head -1)"
    [ -n "$SERVER" ] && INSTALL_FROM_PLIST="$(dirname "$(dirname "$SERVER")")"
  fi
done

# 1) Stop + unregister BOTH launchd agents (so KeepAlive won't relaunch them).
echo "-- stopping service"
for L in $LABELS; do
  launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
pkill -f "bridge/server.mjs" 2>/dev/null || true

# 2) Remove install folders — never a git checkout, never outside $HOME.
remove_install() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  case "$dir" in "$HOME"/*) ;; *) echo "   SKIP (not under home): $dir"; return 0;; esac
  if [ -d "$dir/.git" ]; then echo "   SKIP (source repo, has .git): $dir"; return 0; fi
  if [ -f "$dir/bridge/server.mjs" ] || [ -f "$dir/runtime.json" ]; then
    rm -rf "$dir"; echo "   removed: $dir"
  else
    echo "   SKIP (not a Browser Bridge install): $dir"
  fi
}

echo "-- removing installs"
remove_install "$HOME/Applications/Browser Bridge"
remove_install "$HOME/Downloads/Browser Bridge"
remove_install "$HOME/Documents/Browser Bridge"
remove_install "$HOME/Desktop/Browser Bridge"
remove_install "$INSTALL_FROM_PLIST"

# 3) Old scratch installs from the pre-Applications days (best effort, same guards).
for d in "$HOME/Downloads"/browser-bridge*/ ; do
  [ -d "$d" ] && remove_install "${d%/}"
done

# 4) Reset mcp-remote's saved registration (Claude Desktop's agent cache) so it
# re-registers cleanly against the fresh bridge instead of presenting a stale
# client_id the new bridge won't recognize. Moved to a .bak (recoverable).
if [ -d "$HOME/.mcp-auth" ]; then
  mv "$HOME/.mcp-auth" "$HOME/.mcp-auth.bak-$(date +%s)" && echo "-- reset mcp-remote cache (~/.mcp-auth)"
fi

echo ""
echo "Done. Service + installs + agent cache reset. Your source repo (if any) was left untouched."
echo "Finish the wipe by removing the extension from chrome://extensions,"
echo "then quit + reopen Claude Desktop so its MCP client registers fresh."
echo ""
read -n 1 -s -r -p "Press any key to close."
echo ""
