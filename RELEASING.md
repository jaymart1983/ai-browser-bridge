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

Each is small (~150 KB): bridge source + `extension/` + the one pure-JS runtime dep
(`ws`) + `runtime.json` + installers + `run-bridge.cmd`. **No prerequisites** —
the installer downloads the PINNED Node runtime (from `runtime.json`) into
`runtime/` and points the service at it, so the user needs nothing pre-installed.

### Pinned Node runtime

`runtime.json` is the single source of truth for the Node version everyone runs and
the update repo:

```json
{ "node": "22.14.0", "repo": "jaymart1983/browser-bridge" }
```

- Installers (`install.sh` / `install.ps1`) fetch `node-v<node>` for the platform,
  verify it against the official `SHASUMS256.txt`, drop the binary in `runtime/`,
  and register the service to run it.
- To change the runtime, bump `"node"` and cut a release. The self-updater notices
  the version changed and updates the bundled binary too (macOS: replace in place;
  Windows: stage `runtime\node.new`, which `run-bridge.cmd` swaps in on next start,
  since a running `node.exe` is locked).

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
  `channel: "zip"` and **self-updates silently** — it polls the GitHub Releases API,
  and when a newer version exists it downloads the matching asset, swaps the app
  files over the install dir (your `.bridge-state.json`, grants, pairing, and
  recordings are preserved — they aren't in the zip), updates the Node runtime if
  `runtime.json` changed, restarts via the service manager, and signals the
  extension to reload. Same guardrail: only when auto-update is on (Config →
  Updates). The user sees a ~1–2 s reconnect, nothing to click.

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
- **Windows:** the bridge is plain Node and runs; `install.ps1` registers a logon
  Scheduled Task and `run-bridge.cmd` launches it (swapping a staged runtime update
  first). No tray (systray2 is macOS-only here). Not yet exercised on a Windows
  host — treat `install.ps1` as the reference implementation to validate.
- **No prerequisites:** the installer downloads the pinned Node runtime, so the end
  user needs nothing pre-installed. Zip installs self-update silently (download →
  swap → restart → extension reload), including the Node runtime when it changes.
