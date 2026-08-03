# Embedded mode

Embedded mode lets a **host application** run the real bridge as an internal component —
same relay, same MCP dispatch, same module loading, same rules engine, same state handling
as standalone — with the user-facing surface removed. Upstream fixes flow into the host by
updating the bridge, not by maintaining a fork.

## Launching

```
BRIDGE_EMBEDDED=1
BRIDGE_EMBEDDED_TOKEN=<random, >= 16 chars>          # per-launch bearer + extension auth
BRIDGE_EMBEDDED_EXT_ORIGIN=chrome-extension://<id>   # the ONLY origin allowed to attach
BRIDGE_EMBEDDED_SOURCE=<name>                        # optional; rule-engine source name
                                                     # for the host's calls (default "Host App")
BRIDGE_EMBEDDED_CORE_TOOLS=all|off|<allowlist>       # optional; see "Core tools" below
BRIDGE_PORT=<port>                                   # optional (default 8787)
BRIDGE_STATE_FILE=<path>                             # optional; honored ONLY in embedded mode
node bridge/server.mjs
```

The bridge exits immediately if `BRIDGE_EMBEDDED=1` is set without a valid token or
extension origin — it never boots half-locked-down.

## What changes

| Surface | Standalone | Embedded |
|---|---|---|
| Tray, update checker | on | off (the host owns both) |
| Web control plane (`/`, `/config`, `/modules*`, `/rules*`, …) | loopback UI | **404** |
| OAuth AS (`/oauth/*`, `/.well-known/*`) | DCR + consent | **404** |
| `/command` legacy relay | trusted-local | **404** |
| `POST /mcp` | OAuth bearer | `BRIDGE_EMBEDDED_TOKEN` bearer (constant-time) |
| `GET /health` | open | requires the bearer; unauthenticated → **404** |
| Anything else | route-dependent | **404**, indistinguishable from an unknown path |
| WS `/agent` upgrade | any `chrome-extension://` origin | origin must **exactly** equal `BRIDGE_EMBEDDED_EXT_ORIGIN` **and** carry `?token=` |
| Pairing (`pair_init`) | user clicks Link | rejected — the token is the trust |

An unauthenticated scanner on loopback cannot distinguish an embedded bridge from a
closed port's 404s: no service name, no version, no route shape.

## Extension side

The host ships this repo's extension unmodified and writes **`embedded.json`** into the
extension directory before loading it:

```json
{ "token": "<same value as BRIDGE_EMBEDDED_TOKEN>", "bridgeUrl": "ws://127.0.0.1:8787/agent" }
```

When that file is present the extension appends `?token=` to the WS upgrade, derives the
frame-signing key as `SHA-256(token)` (the bridge derives the same key, so the existing
per-frame HMAC verification works unchanged), and disables interactive pairing — the
popup shows "Managed by host application".

The offscreen document (which owns the socket) reads `embedded.json` itself and uses it
for its **first** dial, so the socket never touches the default port — it does not
depend on a later `CONFIG` message from the service worker. The popup reports the
**effective** socket target (token redacted), hides the control-panel button (embedded
mode has no control plane), and distinguishes *managed/linked* (a key exists) from
*connected* (the socket is open right now).

A refused WS upgrade is always logged, naming the presented origin and whether the
token was missing or mismatched (never the expected value), so a misconfigured host
is diagnosable from the bridge log instead of a silent 403.

## Core tools

By default an embedded bridge serves its modules' tools **and** the core `browser_*`
tools, exactly like standalone. A host whose module already declares its full intended
capability surface can withhold them:

```
BRIDGE_EMBEDDED_CORE_TOOLS=all                              # default — everything
BRIDGE_EMBEDDED_CORE_TOOLS=all,-browser_eval                # everything EXCEPT these
BRIDGE_EMBEDDED_CORE_TOOLS=browser_focused_tab,browser_read # explicit allowlist
BRIDGE_EMBEDDED_CORE_TOOLS=off                              # modules' tools only
```

**The exclusion form is usually the right one.** A host that enforces a guard in code
needs to drop `browser_eval` specifically — a broad primitive can construct any request
itself, so leaving it reachable makes a module-level gate advisory — while keeping the
rest of the capability surface (reads, clicks, navigation, annotation, recording).
`off` is a blunt instrument: it also removes tab enumeration and the focused-tab query,
which a host then has to reimplement in its module.

Withheld tools are removed from `tools/list` **and** refused on `tools/call` (an
unadvertised tool must not be reachable by guessing its name), and the generic core-tool
preamble is dropped from the server `instructions`. Module tools are never affected.
Ignored in standalone mode.

## Status for a host status page

`GET /health` (with the bearer) returns everything a host needs to render its own
"is the bridge working?" page:

```json
{
  "ok": true, "service": "browser-bridge", "version": "0.1.24", "embedded": true,
  "host": "127.0.0.1", "port": 47830,
  "url": "http://127.0.0.1:47830", "mcpUrl": "http://127.0.0.1:47830/mcp",
  "browserConnected": true,
  "agent": { "name": "AI Analyst", "lastSeen": 1785440000000, "active": true },
  "modulesEnabled": ["ai-analyst"], "rules": 1, "coreTools": []
}
```

`browserConnected` is the extension's socket; `agent.active` is whether an authorized
`/mcp` call happened in the last 2 minutes. They fail independently — a page that shows
only one of them will mislead. **A `/health` poll never counts as agent traffic**, so
`agent.active` means real use, not merely something watching. `coreTools` is `"all"` or
the effective allowlist (`[]` when `off`).

## The popup in embedded mode

The popup becomes a read-only status panel: bridge reachable, `host:port`, bridge
version, whether the host's agent is connected, and whether the browser is attached.
Linking, agent approvals, the control-panel link, module nav and update prompts are all
hidden — the host application owns that interface.

This is a change to what the **end user is shown**, not to what agents can do. An
embedded host keeps the full capability surface unless it opts out via
`BRIDGE_EMBEDDED_CORE_TOOLS`.

## Which tab is the user looking at

`browser_focused_tab` returns the active tab of the **focused window** — at most one.
Prefer it over scanning `browser_tabs_list` for `active: true`: `active` is per window,
so with several windows open multiple tabs report `active: true` and none of them
identifies the tab with the user's attention. `browser_tabs_list` now also carries
`windowId` and `focused` per tab. Both are `read`-verb tools and their results are
filtered by read permission, so a tab the source may not read is withheld rather than
leaked.

## Rule-engine identity

Calls through `/mcp` evaluate with the source name `BRIDGE_EMBEDDED_SOURCE`. Rules are
seeded by modules exactly as in standalone (there is no UI, so modules should declare
`autoEnable: true` and ship the base rules they need).

## Module tools and verbs

A module tool may declare a `verb` from the closed vocabulary
`read | write | control | record | annotate`:

```js
tools: {
  fetch_thing:  { verb: 'read',  description, inputSchema, handler },
  apply_change: { verb: 'write', description, inputSchema, handler },
}
```

Declared-verb tools are evaluated by the rules engine exactly like core tools:
`(source → destination : verb)`, with the target URL derived from the call's `tabId`,
`url`, or `host` argument (none → evaluated on source + verb alone). A rule like
*"Any Agent → jira : deny write"* therefore covers module tools too, and stays
meaningful to a user who has never heard of the module. A tool with **no** verb keeps
the previous ungated behaviour (the module self-gates); don't invent new verbs.
