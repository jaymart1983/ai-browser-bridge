// clients.mjs — detect installed MCP clients (AI agents) and write/remove the
// bridge's MCP server entry into each one's OWN config file, so the user connects
// agents from the bridge UI instead of hand-editing configs or running CLI.
//
// Loopback + user-driven ONLY: these functions are reached from the /config web UI
// (localhost), never exposed as MCP tools, so an agent can't wire itself in. Every
// write backs up the target file first and touches only our single entry.
//
// Each adapter knows its client's config path (per-OS), file format, and how that
// client talks to a remote OAuth MCP server:
//   * http-native — the client speaks Streamable-HTTP + OAuth itself (Claude Code).
//   * remote       — the client has a native remote-MCP entry type (OpenCode).
//   * mcp-remote   — the client only does stdio, so it shells out to the `mcp-remote`
//                    npm shim which bridges to our HTTP+OAuth endpoint (Claude Desktop, Codex).

import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const IS_WIN = platform() === 'win32';
const ENTRY = 'browser-bridge';                          // the MCP server key we write
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;          // the bridge's MCP endpoint

// --- small fs helpers --------------------------------------------------------
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function backup(p) { try { if (existsSync(p)) copyFileSync(p, p + '.bak-browserbridge'); } catch { /* best effort */ } }
function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); backup(p); writeFileSync(p, JSON.stringify(obj, null, 2)); }
const anyExist = (paths) => paths.some((p) => p && existsSync(p));

// Resolve a real `npx` for the shim-based clients. GUI apps (Claude Desktop) are
// launched without the user's shell PATH, so a bare "npx" often fails — prefer an
// absolute path. Cached after first lookup.
let _npx;
function resolveNpx() {
  if (_npx !== undefined) return _npx;
  _npx = null;
  const cands = IS_WIN
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npx.cmd'), join(process.env.APPDATA || '', 'npm', 'npx.cmd')]
    : ['/opt/homebrew/bin/npx', '/usr/local/bin/npx', '/usr/bin/npx', join(HOME, '.volta/bin/npx'), join(HOME, '.nvm/current/bin/npx')];
  for (const c of cands) { if (c && existsSync(c)) { _npx = c; break; } }
  if (!_npx) {
    try {
      const out = IS_WIN
        ? execFileSync('where', ['npx'], { encoding: 'utf8' })
        : execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v npx'], { encoding: 'utf8' });
      const line = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (line && existsSync(line)) _npx = line;
    } catch { /* none found */ }
  }
  return _npx;
}
function shimEntry() { const npx = resolveNpx() || 'npx'; return { command: npx, args: ['-y', 'mcp-remote', MCP_URL, '--transport', 'http-only'] }; }

// --- TOML block editing (Codex) ---------------------------------------------
// Line-based so it survives array values that contain "[" (regex can't). Removes any
// existing [header] table (its lines up to the next table or EOF), then optionally
// appends a fresh one.
function tomlSetBlock(text, header, body) {
  const out = [];
  let skipping = false;
  for (const ln of text.split('\n')) {
    if (ln.trim() === header) { skipping = true; continue; }
    if (skipping) { if (/^\s*\[/.test(ln)) skipping = false; else continue; }
    out.push(ln);
  }
  let res = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (body) res = (res ? res + '\n\n' : '') + header + '\n' + body;
  return res ? res + '\n' : '';
}

// --- adapters ----------------------------------------------------------------
// file: config path · appHints: extra install markers · container: JSON key holding
// MCP servers · entry(): our value · format: 'json'|'toml' · kind: 'gui'|'cli'.
const ADAPTERS = [
  {
    id: 'claude-desktop', name: 'Claude Desktop', kind: 'gui', transport: 'mcp-remote', format: 'json', container: 'mcpServers',
    file: IS_WIN ? join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
                 : join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    appHints: IS_WIN ? [join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude')] : ['/Applications/Claude.app'],
    entry: shimEntry,
  },
  {
    id: 'claude-code', name: 'Claude Code', kind: 'cli', transport: 'http-native', format: 'json', container: 'mcpServers',
    file: join(HOME, '.claude.json'),
    appHints: [join(HOME, '.claude')],
    entry: () => ({ type: 'http', url: MCP_URL }),
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'cli', transport: 'remote', format: 'json', container: 'mcp',
    file: join(HOME, '.config', 'opencode', 'opencode.json'),
    appHints: [join(HOME, '.config', 'opencode')],
    entry: () => ({ type: 'remote', url: MCP_URL, enabled: true }),
  },
  {
    id: 'codex', name: 'Codex', kind: 'cli', transport: 'mcp-remote', format: 'toml',
    file: join(HOME, '.codex', 'config.toml'),
    appHints: [join(HOME, '.codex')],
  },
];
const byId = (id) => ADAPTERS.find((a) => a.id === id);

function status(a) {
  const installed = anyExist([a.file, ...(a.appHints || [])]);
  let configured = false;
  if (a.format === 'toml') configured = existsSync(a.file) && new RegExp('\\[mcp_servers\\.' + ENTRY + '\\]').test(readFileSync(a.file, 'utf8'));
  else { const cfg = readJson(a.file); configured = !!(cfg && cfg[a.container] && cfg[a.container][ENTRY]); }
  return { installed, configured };
}

function connect(a) {
  if (a.format === 'toml') {
    const npx = resolveNpx() || 'npx';
    const body = `command = ${JSON.stringify(npx)}\nargs = ["-y", "mcp-remote", ${JSON.stringify(MCP_URL)}, "--transport", "http-only"]`;
    const text = existsSync(a.file) ? readFileSync(a.file, 'utf8') : '';
    mkdirSync(dirname(a.file), { recursive: true }); backup(a.file);
    writeFileSync(a.file, tomlSetBlock(text, `[mcp_servers.${ENTRY}]`, body));
  } else {
    const cfg = readJson(a.file) || {};
    cfg[a.container] = cfg[a.container] || {};
    cfg[a.container][ENTRY] = a.entry();
    writeJson(a.file, cfg);
  }
  return { ok: true };
}

function disconnect(a) {
  if (!existsSync(a.file)) return { ok: true };
  if (a.format === 'toml') { backup(a.file); writeFileSync(a.file, tomlSetBlock(readFileSync(a.file, 'utf8'), `[mcp_servers.${ENTRY}]`, null)); return { ok: true }; }
  const cfg = readJson(a.file); if (!cfg || !cfg[a.container]) return { ok: true };
  delete cfg[a.container][ENTRY];
  if (cfg[a.container] && Object.keys(cfg[a.container]).length === 0) delete cfg[a.container]; // don't leave an empty {} behind
  writeJson(a.file, cfg); return { ok: true };
}

// --- public API (consumed by server.mjs routes) -----------------------------
export function listClients() {
  return ADAPTERS.map((a) => {
    const s = status(a);
    const usesShim = a.transport === 'mcp-remote';
    return {
      id: a.id, name: a.name, kind: a.kind, transport: a.transport, file: a.file,
      installed: s.installed, configured: s.configured,
      usesShim, npxFound: usesShim ? !!resolveNpx() : null,
      restartHint: a.kind === 'gui' ? `Quit and reopen ${a.name}` : `Start a new ${a.name} session`,
    };
  });
}

export function connectClient(id) {
  const a = byId(id); if (!a) return { ok: false, error: 'unknown client' };
  if (!status(a).installed) return { ok: false, error: `${a.name} not detected on this machine` };
  try {
    connect(a);
    const usesShim = a.transport === 'mcp-remote';
    const warn = usesShim && !resolveNpx() ? 'Node/npx not found — install Node so mcp-remote can run, or this entry will fail to start.' : null;
    return { ok: true, restartHint: a.kind === 'gui' ? `Quit and reopen ${a.name}` : `Start a new ${a.name} session`, warn };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

export function disconnectClient(id) {
  const a = byId(id); if (!a) return { ok: false, error: 'unknown client' };
  try { return disconnect(a); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
