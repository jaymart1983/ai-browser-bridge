# Browser Bridge

A local bridge plus a browser extension that lets AI agents drive your real,
logged-in browser under rules you control. It runs entirely on your machine
(loopback only) and speaks the Model Context Protocol, so any MCP-capable agent
(Claude Code, Claude Desktop, OpenCode, and others) can use it once you
authorize that agent.

Nothing leaves your device. The bridge listens only on 127.0.0.1. Each agent
gets its own authorization that you can revoke at any time, and every action is
checked against rules before it runs.

## How it works

There are two halves:

- The extension is thin. Its only jobs are to pair with the bridge and to run
  the browser commands the bridge signs. It holds no policy.
- The bridge is the brain. It is an MCP server, its own OAuth authorization
  server, a rule engine, and a small web control panel. It decides what each
  agent is allowed to do and relays approved commands to the extension.

Access is granted by rules of the form Source, Destination, Permission, and
denied by default:

- Source is the agent, identified by the name it registered under.
- Permission is one of read, write, control, or record.
- Destination is a set of sites matched by origin or URL pattern.

Capabilities are added as modules. A module is a single file dropped into
bridge/modules that registers its own rules, tools, and settings pages. The
project ships one example module, Deep Research, which lets an agent read,
navigate, control, and record a chosen set of tabs.

## Requirements

- macOS (the installer sets up a launchd login agent; the bridge itself is
  plain Node and runs anywhere)
- Node.js 18 or newer
- Google Chrome or another Chromium browser
- An MCP-capable agent

## Install (no prerequisites)

You do not need Node or anything else installed. The installer downloads the latest
release, fetches a pinned Node runtime, and starts the bridge.

### One command in a terminal (recommended — no security prompt)

Because these are fetched with curl/PowerShell (not a browser), macOS Gatekeeper /
Windows SmartScreen do not flag them:

- macOS: `curl -fsSL https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.sh | bash`
- Windows: `irm https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.ps1 | iex`

Each installs to a Browser Bridge folder (`~/Applications/Browser Bridge` on macOS,
`%LOCALAPPDATA%\Programs\Browser Bridge` on Windows), fetches a pinned Node runtime,
and starts the bridge.

### Or download and double-click

Grab the installer for your OS from the
[latest release](https://github.com/jaymart1983/browser-bridge/releases/latest):

- **macOS** — download `Install-Browser-Bridge-macOS-*.zip`; it expands to
  **`Install Browser Bridge.command`**. Because it's downloaded and not
  Apple-notarized, macOS will say it "cannot be verified." To allow it: try to open
  it once, then go to **System Settings → Privacy & Security** and click
  **"Open Anyway"**, then Open. (This is a one-time step per download.)
- **Windows** — download `Install-Browser-Bridge-Windows-*.cmd` and double-click; if
  SmartScreen warns, click "More info" → "Run anyway."

Then load the extension (one time): open `chrome://extensions`, turn on Developer
mode, click Load unpacked, and select the `extension` folder inside the install
directory (the installer opens it for you). Click **Link** in the extension popup.

To start or stop the bridge later, double-click **Start Browser Bridge** or
**Stop Browser Bridge** in the install folder.

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

5. Enable a module and set access. Open http://127.0.0.1:8787, go to Modules,
   enable Deep Research, then open it and choose which tabs agents may use.

6. Connect your agent. See "Connecting an agent" below. In short: register
   http://127.0.0.1:8787/mcp with your agent, authenticate, and approve the
   request in the extension popup.

Once connected, the agent has the browser tools (browser_navigate, browser_eval,
browser_read, browser_screenshot, and so on), limited to what your rules allow.

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
- Modules: enable, disable, upload, or delete capability modules
- Rules: build and edit the Source, Destination, Permission rules
- Each enabled module has its own page for its settings

You can also reach these from the extension popup and the menu bar tray icon.

## Security model

- Loopback only. The bridge binds to 127.0.0.1 and refuses non-local hosts.
- Bridge and extension are paired with an ECDH key exchange. The bridge signs
  every command it relays, and the extension runs only signed commands.
- Agents authenticate with OAuth 2.1 and PKCE. Each grant is per agent and
  revocable from the control panel or the popup.
- Deny by default. An agent can do nothing until a rule allows it.

## Uninstall

```
./uninstall.sh
```

This stops the bridge and removes the login agent. Then remove the extension
from chrome://extensions.

## License

MIT. See LICENSE.
