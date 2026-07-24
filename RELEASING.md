# Building and releasing Browser Bridge

This is the full build → package → release → auto-update process. It is written so
any developer (human or AI) can pick it up cold.

## What Browser Bridge is (one paragraph)

A local **bridge** (`bridge/`, Node.js, runs as a background service) plus a thin
**browser extension** (`extension/`, MV3, loaded unpacked). The bridge speaks MCP +
OAuth to AI agents on loopback and relays approved commands to the extension over a
signed WebSocket. There is no build step for running from source — it is plain
Node + plain extension. "Building" here means packaging a **self-contained release
zip** for distribution, and "releasing" means tagging + publishing it so installs
can auto-update.

## Versioning

Two independent versions, both currently `0.1.0`:

| Version | Source of truth | Shown |
|---|---|---|
| Bridge | `bridge/package.json` → `version` | control panel nav, `/health`, module headers |
| Extension | `extension/manifest.json` → `version` | extension popup ("extension vX") |

Bump both to the release version before cutting a release (keep them in lockstep
unless you have a reason not to). The git **tag** is the release identity:
`v<version>` (e.g. `v0.2.0`).

## Build the release zips

```
cd browser-bridge
npm install --prefix bridge        # ensure bridge/node_modules/ws exists
node scripts/build-release.mjs
```

Output in `dist/`:

- `browser-bridge-macos-v<version>.zip`
- `browser-bridge-windows-v<version>.zip`

Each is **self-contained**: bridge source + `extension/` + the one runtime dep
(`ws`, pure JavaScript, cross-platform) + both installers. No git clone, no
`npm install` on the user's side. **Node.js is the only prerequisite** (installers
check for it and error clearly if missing).

Deliberately excluded from the zip: `.git/`, `node_modules/` except `ws`,
`bridge/.bridge-state.json*` (secrets/grants), `bridge/bridge.log`, `recordings/`.

### The tray dependency (`systray2`)

`systray2` (the macOS menu-bar tray) ships a platform-specific helper binary, so it
is **not** bundled — it would only be valid for one OS. The tray is optional:
`bridge/tray.mjs` loads it defensively and the bridge runs fine without it. macOS
users who want the tray run `npm install` in `bridge/` after extracting. If you
ever want a truly turnkey tray, build the macOS zip on macOS with `systray2`
installed and ship a macOS-only `bridge/node_modules`.

## Cut a release

```
# 1. bump versions in bridge/package.json and extension/manifest.json
# 2. commit + push
git commit -am "Release v0.2.0" && git push origin main
# 3. tag + push the tag
git tag v0.2.0 && git push origin v0.2.0
# 4. build the zips
node scripts/build-release.mjs
# 5. publish the GitHub Release with the two zips attached
gh release create v0.2.0 dist/browser-bridge-*-v0.2.0.zip \
  --title "Browser Bridge v0.2.0" --notes "…changes…"
```

The repo is public, so the Release (and its zip assets) are public automatically.

## How installs update

Two install shapes, two update paths:

- **Git-clone install** (cloned the repo, ran the installer): the bridge's
  `bridge/updater.mjs` fetches tags every 6h and, when auto-update is on (Config →
  Updates), **fast-forwards the clone to the newest release tag** and restarts.
  Guardrails: fast-forward only, clean tree only, no local-ahead commits. If the
  release changed `extension/`, the bridge signals connected extensions to
  `chrome.runtime.reload()` so they pick up the new code too.
- **Zip install** (extracted a release zip; no `.git`): the updater reports
  `channel: "zip"` and does **not** self-update. To update, download the newer
  release zip and re-run the installer. (A future enhancement can auto-download the
  release asset via the GitHub API; the hook is documented in `updater.mjs`.)

## Install (end user)

Recommended home: **`~/Applications/Browser Bridge`** (macOS) — a visible,
easy-to-reach user-app folder. Extract the zip there, then:

- **macOS:** `./install.sh` — sets up the launchd login agent, starts the bridge,
  opens `extension/` in Finder. Then `chrome://extensions` → Developer mode → Load
  unpacked → the `extension` folder. (One time — the extension self-reloads on
  future updates.)
- **Windows:** `powershell -ExecutionPolicy Bypass -File install.ps1` — registers a
  logon Scheduled Task (KeepAlive-like), starts the bridge, opens `extension\` in
  Explorer. Then Load-unpacked as above.

## File map (for a dev picking this up)

```
bridge/
  server.mjs      HTTP + WS server; routes; relays commands to the extension
  oauth.mjs       OAuth 2.1 AS (DCR, PKCE, refresh rotation, consent)
  pairing.mjs     ECDH pairing; multi-browser keys; active-browser routing
  rules.mjs       policy engine (Source → Destination : Permission), top-down
  modules.mjs     capability-module loader (bridge/modules/*.mjs)
  updater.mjs     self-update to the latest release tag (this doc)
  ui.mjs          web control panel (Config / Modules / Rules + module pages)
  state.mjs       durable 0600 JSON store (grants, pairing, rules, settings)
  tray.mjs        optional macOS menu-bar tray (systray2, defensive load)
extension/        MV3 extension: background.js (SW), offscreen.js (WS), popup.*
scripts/
  build-release.mjs   builds dist/*.zip (this doc)
install.sh / .ps1     per-OS installers
```

## Cross-platform status

- **macOS:** fully supported (launchd service, tray, self-update).
- **Windows:** the bridge is plain Node and runs; `install.ps1` provides a logon
  Scheduled Task. No tray (systray2 is macOS-only here), and git self-update needs
  git present. Zip installs update by re-downloading. Not yet exercised on a
  Windows host — treat `install.ps1` as the reference implementation to validate.
- **Bundling Node itself** (so Node is not even a prerequisite) is a possible future
  step via Node SEA or `pkg`; not done today.
