# Browser Bridge

A local bridge plus a browser extension that lets AI agents drive your real,
logged-in browser on sites you choose. It runs entirely on your machine
(loopback only) and speaks the Model Context Protocol, so any MCP-capable agent
(Claude Code, Claude Desktop, OpenCode, and others) can use it once you
authorize that agent.

Nothing leaves your device. The bridge listens only on 127.0.0.1. Each agent
gets its own authorization that you can revoke at any time, and no agent can
touch a site you have not enabled.

## How it works

There are two halves:

- The extension is thin. Its only jobs are to pair with the bridge and to run
  the browser commands the bridge signs. It holds no policy.
- The bridge is the brain. It is an MCP server, its own OAuth authorization
  server, an automation scheduler, and a small web control panel.

An authorized agent gets the full set of primitives: list tabs, read a page,
click, fill, scroll, navigate, open and close tabs, upload and download files,
record a tab to disk, and annotate over the page. There is one access control,
and it is the one worth having: **what may be done, and where**. Under Tabs you
write an ordered list of site rules, read top to bottom, ending in a default line
that covers everything else. Each row grants **read**, **control**, **record** and
**annotate** independently, so "read my bank but never touch it" is a row, not a
compromise.

`read` is the master: with read off for a site, nothing else applies there. And
there is no separate "write" — filling a field can submit a form, so typing and
clicking are both `control`. A refusal names the site and the capability, and
applies equally to agents and to scheduled modules.

## Automations (modules)

A module is a single file dropped into `bridge/modules`. It is not a way to give
an agent new tools — agents already have them all. A module is code that runs
**inside the bridge on a schedule, with no agent present**: "every weekday at
09:00, once someone is actually at the browser, open these three tabs, let me
sign in, then record them."

Time of day is the trigger. Being at the browser is a *gate*: a module with
`authRequired: true` arms at 09:00 and waits, so a laptop opened at 09:41 gets
its run at 09:41 instead of an auth prompt nobody saw. Modules obey the same
Tabs setting agents do, and may only use the actions they declare.

Agents write modules for you rather than calling them — `module_authoring_guide`
and `module_template` over MCP give an agent the exact contract. The first
install of a module id needs your approval in the extension popup; after that
the owning agent can keep it up to date on its own.

No modules ship with the bridge — it starts empty, and stays that way until you
add one. Ask a connected agent for `module_template` to see the full shape.

## Requirements

- macOS (the installer sets up a launchd login agent; the bridge itself is
  plain Node and runs anywhere)
- Node.js 18 or newer
- Google Chrome or another Chromium browser
- An MCP-capable agent

## Install (one command, no prerequisites)

You do not need Node or anything else installed. Paste one line into a terminal —
it downloads the latest release, fetches a pinned Node runtime, and starts the
bridge. Fetched with curl/PowerShell (not a browser), so macOS Gatekeeper /
Windows SmartScreen do not flag it:

**macOS**
```
curl -fsSL https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.sh | bash
```

**Windows** (PowerShell)
```
irm https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.ps1 | iex
```

It installs to a Browser Bridge folder (`~/Applications/Browser Bridge` on macOS,
`%LOCALAPPDATA%\Programs\Browser Bridge` on Windows) and starts the bridge in the
background at login. The control panel is at http://127.0.0.1:8787.

Then, one time:

1. **Load the extension** — open `chrome://extensions`, turn on Developer mode,
   click **Load unpacked**, and select the `extension` folder inside the install
   directory. Click **Link** in the extension popup.
2. **Connect your agents** — open the control panel (http://127.0.0.1:8787/config)
   and use the **Connect AI agents** tiles. The bridge detects installed clients
   (Claude Desktop, Claude Code, OpenCode, Codex) and writes the MCP config for
   each one you pick. Restart that app, then click **Approve** in the extension
   popup. No CLI, no hand-editing config files.

## Setup from source (developers)

1. Clone the repository and enter it.

2. Install and start the bridge (runs IN PLACE — it does not move files; put the
   folder where you want it first):

   ```
   ./install.sh
   ```

   This downloads the pinned Node runtime and runs the bridge in the background,
   starting it again at login. The control panel is at http://127.0.0.1:8787.

3. Load the extension in your browser:

   - Open chrome://extensions
   - Turn on Developer mode
   - Click Load unpacked and select the extension folder

4. Open the extension and click Link. This performs a one-time key exchange so
   the bridge and the extension trust each other. After linking, the browser is
   paired and no shared password is used.

5. Decide what agents may do. Open http://127.0.0.1:8787/tabs. The bottom line
   ("Everything else") starts all-off, so nothing works until you turn something
   on there, or add a site rule above it.

6. Connect your agent. See "Connecting an agent" below. In short: register
   http://127.0.0.1:8787/mcp with your agent, authenticate, and approve the
   request in the extension popup.

Once connected, the agent has the full browser tool set (browser_navigate,
browser_read, browser_click, browser_fill, browser_screenshot, browser_download,
browser_upload, browser_annotate, browser_monitor_*, and so on), each usable
wherever your Tabs rules grant the matching capability. browser_tabs_list reports
`can:{read,control,record,annotate}` per tab, so an agent can see its limits
without probing for them.

## Connecting an agent

The bridge is a standard remote MCP server that is also its own OAuth
authorization server, so any MCP client that supports remote HTTP servers can
connect. The flow is always the same three steps:

1. Register the server URL with your agent: http://127.0.0.1:8787/mcp
2. Authenticate. The agent opens your browser for a one-time consent.
3. Approve. A request appears in the extension popup (and on the consent page).
   Click Approve. The grant is permanent and revocable from the popup or Config.

Because the bridge is loopback only, the agent must run on the same machine you
are on. A cloud-hosted agent (for example the claude.ai website) cannot reach
127.0.0.1 without a public tunnel and is not recommended.

Also remember that connecting an agent and linking the browser are two separate
things. Authenticating lets the agent reach the bridge; clicking Link in the
extension is what lets the bridge drive your browser. If you skip the link,
calls fail with a signature error.

### Claude Code (recommended for a local bridge)

Register it once, then authenticate:

    claude mcp add --transport http browser-bridge http://127.0.0.1:8787/mcp

Then run /mcp in an interactive session, select browser-bridge, and choose
Authenticate. If instead you keep the server in a project .mcp.json file, Claude
Code asks you to approve the project's servers on startup before it appears in
/mcp; if that prompt never showed, register it with the command above or run
claude mcp reset-project-choices and restart.

### Claude Desktop

Do not use Settings > Connectors > Add custom connector for a local bridge. That
path fetches the server from Anthropic's cloud, which cannot reach 127.0.0.1,
and it rejects plain http URLs. Instead run the bridge through the mcp-remote
shim, which runs locally and handles the browser OAuth for you. Edit
~/Library/Application Support/Claude/claude_desktop_config.json:

    {
      "mcpServers": {
        "browser-bridge": {
          "command": "npx",
          "args": ["mcp-remote", "http://127.0.0.1:8787/mcp", "--transport", "http-only"]
        }
      }
    }

Quit and reopen Claude Desktop. mcp-remote opens your browser for consent, and
the approval appears in the extension popup.

### OpenCode and other agents

Any MCP client that supports remote (HTTP) servers with OAuth can connect. Add a
remote MCP server pointing at http://127.0.0.1:8787/mcp and complete the browser
consent.

### How to find the right method for your agent

Every agent registers MCP servers its own way. To find yours, search that
agent's documentation or settings for one of these terms: MCP, MCP server,
remote MCP, connectors, or tools. You want the option to add a remote or HTTP
MCP server by URL, not a local command or stdio server. Point it at
http://127.0.0.1:8787/mcp. The server advertises its OAuth endpoints at
http://127.0.0.1:8787/.well-known/oauth-protected-resource, so a spec-compliant
client discovers the login flow automatically. If your agent runs in the cloud
rather than on your machine, it cannot reach a loopback address without a tunnel.

## Managing it

Everything is in the web control panel at http://127.0.0.1:8787:

- Config: pairing status, authorized agents, storage usage
- Tabs: which sites agents and modules may act on, and where each tab's
  recording is saved (temporary or kept)
- Modules: enable, disable, upload, or delete automations; each module's page
  shows its schedule, what it may do, its owner, and its last and next run
- Each enabled module can add a page of its own

You can also reach these from the extension popup and the menu bar tray icon.

## Security model

- Loopback only. The bridge binds to 127.0.0.1 and refuses non-local hosts.
- Bridge and extension are paired with an ECDH key exchange. The bridge signs
  every command it relays, and the extension runs only signed commands.
- Agents authenticate with OAuth 2.1 and PKCE. Each grant is per agent and
  revocable from the control panel or the popup.
- Deny by default. Tab access starts Off; an agent can reach nothing until you
  enable a site.
- The bridge never fills a password field, and refuses to, in the extension
  itself rather than by policy alone.
- A module runs under the same tab access as an agent, and only with the
  actions it declared. Installing one grants no extra reach.

## Uninstall

```
./uninstall.sh
```

This stops the bridge and removes the login agent. Then remove the extension
from chrome://extensions.

## License

MIT. See LICENSE.
