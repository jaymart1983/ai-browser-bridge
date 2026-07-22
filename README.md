# AI Browser Bridge

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

## Setup

1. Clone the repository and enter it.

2. Install and start the bridge:

   ```
   ./install.sh
   ```

   This installs dependencies and runs the bridge in the background, starting
   it again at login. The control panel is at http://127.0.0.1:8787.

3. Load the extension in your browser:

   - Open chrome://extensions
   - Turn on Developer mode
   - Click Load unpacked and select the extension folder

4. Open the extension and click Link. This performs a one-time key exchange so
   the bridge and the extension trust each other. After linking, the browser is
   paired and no shared password is used.

5. Enable a module and set access. Open http://127.0.0.1:8787, go to Modules,
   enable Deep Research, then open it and choose which tabs agents may use.

6. Connect your agent. For Claude Code:

   ```
   claude mcp add --transport http ai-browser-bridge http://127.0.0.1:8787/mcp
   ```

   Then start the authorization from your agent (in Claude Code, run /mcp and
   authenticate). Your browser opens a consent page, and a matching request
   appears in the extension popup. Approve it in either place.

That is it. The agent now has the browser tools (browser_navigate,
browser_eval, browser_read, browser_screenshot, and so on), limited to what
your rules allow.

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
