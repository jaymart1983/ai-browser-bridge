// server.mjs — the local bridge.
//
// Two faces on a single loopback port (127.0.0.1:8787):
//   * WebSocket at /agent  — the browser extension's offscreen document connects
//     here and stays connected. Commands are pushed to it; replies come back.
//   * HTTP POST at /command — AI/CLI tools submit a JSON command. The bridge
//     relays it to the extension over the WS, correlates the reply by `id`, and
//     returns it as the HTTP response (request/response bridging).
//
// SECURITY MODEL
//   * Binds strictly to 127.0.0.1 — never 0.0.0.0 — so nothing off-host can
//     reach it. Loopback is the trust boundary.
//   * The HTTP side rejects requests that carry a cross-origin `Origin` header
//     and validates the `Host` header, so a malicious web page in the user's
//     browser cannot use fetch() to drive the bridge (DNS-rebinding / CSRF-style
//     attacks). Real CLI tools send no Origin and a loopback Host, so they pass.
//   * The WS side only accepts upgrades to /agent from a chrome-extension://
//     origin (or no origin), so a web page cannot impersonate the extension.
//   * Authorization itself (the bearer access code) is enforced INSIDE the
//     extension, not here — the bridge is an untrusted relay. Even local
//     processes must send the valid access code (as `token`) on every request.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, statSync, renameSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTray, setTrayState, stopTray } from './tray.mjs';
import { oauthHandle, validateToken, wwwAuthenticate, listAgents, listPending, listStale, revokeAgent, removeClient, configureOAuth } from './oauth.mjs';
import { mcpHandle } from './mcp.mjs';
import { pairInit, signFrame, unpairBrowser, pairingStatus, listBrowsers, setActiveBrowser, touchBrowser, adoptLegacyForBrowser } from './pairing.mjs';
import { configureRules, resolveTabUrl } from './rules.mjs';
import { configureModules, loadModules, setDestinationContents, refreshModuleDestinations } from './modules.mjs';
import { uiRoutes } from './ui.mjs';
import { state, save } from './state.mjs';

const HOST = '127.0.0.1'; // loopback ONLY — do not change to 0.0.0.0
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const AGENT_PATH = '/agent';
const COMMAND_PATH = '/command';
const COMMAND_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 30000);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB (screenshots/HTML can be large)

// Linked browsers can each hold an open agent socket. Commands are relayed to the
// ACTIVE browser only; the others stay connected (for status + fast switching).
const agentSockets = new Map(); // browserId -> ws
let legacySocket = null; // most-recent socket that hasn't reported a browser id yet
function activeSocket() {
  const mapped = state.activeBrowser && agentSockets.get(state.activeBrowser);
  if (mapped && mapped.readyState === mapped.OPEN) return mapped;
  // Backward-compat: a pre-multi-browser extension connects but never sends a
  // browser id. While a legacy pairing key exists, route to that socket (signed
  // with the legacy key) so it keeps working until the user reloads the extension.
  if (state.pairing && state.pairing.key && legacySocket && legacySocket.readyState === legacySocket.OPEN && !legacySocket._browserId) return legacySocket;
  return null;
}
function agentConnected() { return !!activeSocket(); }
function connectedBrowserIds() {
  const set = new Set();
  for (const [id, ws] of agentSockets) if (ws.readyState === ws.OPEN) set.add(id);
  return set;
}
function broadcastToAgents(obj) {
  const s = JSON.stringify(obj);
  for (const ws of agentSockets.values()) { try { if (ws.readyState === ws.OPEN) ws.send(s); } catch {} }
}
function sendToOneAgent(ws, obj) { try { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {} }

// Correlation table: id -> { resolve, reject, timer }.
const pending = new Map();

let idCounter = 0;
function nextId() {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `srv-${Date.now().toString(36)}-${idCounter}`;
}

// ---------------------------------------------------------------------------
// Origin / host validation helpers
// ---------------------------------------------------------------------------
function isLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return false;
  // Strip the optional :port.
  const host = String(hostHeader).split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// For the HTTP command endpoint: browsers attach an Origin header on cross-site
// fetches. We refuse any Origin that is not a loopback http(s) origin. Requests
// with NO Origin (curl, Node fetch to loopback, native tools) are allowed.
function httpOriginAllowed(origin) {
  if (!origin) return true; // non-browser client
  // The extension popup/SW is a trusted local client (its own /command calls are
  // still bearer-gated); allow its origin so it can read /monitor storage stats.
  if (/^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin)) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

// For the WS /agent endpoint: only the extension should connect. Its offscreen
// document has a chrome-extension:// origin. Allow that (or no origin); reject
// http(s)/ws page origins so a web page cannot register as the agent.
function wsOriginAllowed(origin) {
  if (!origin) return true;
  return /^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Uniform CORS refusal: we never enable CORS. Loopback-only.
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (!isLoopbackHostHeader(host)) {
    return sendJson(res, 421, { error: { code: 'BAD_HOST', message: 'Loopback host required.' } });
  }
  if (!httpOriginAllowed(origin)) {
    return sendJson(res, 403, {
      error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests are not allowed.' },
    });
  }

  const url = new URL(req.url, `http://${host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'ai-browser-bridge',
      agentConnected: agentConnected(),
      commandPath: COMMAND_PATH,
      agentPath: AGENT_PATH,
    });
  }

  // Live activity dashboard (loopback only; shows your own capture).
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    return serveDashboard(res);
  }
  if (req.method === 'GET' && url.pathname === '/monitor/sessions') {
    return sendJson(res, 200, {
      agentConnected: agentConnected(),
      sessions: listSessions(), usage: usageByRoot(), roots: { tmp: MON_ROOTS.tmp, perm: MON_ROOTS.perm },
    });
  }
  if (req.method === 'GET' && url.pathname === '/monitor/events') {
    const key = url.searchParams.get('key') || '';
    const root = url.searchParams.get('root') || '';
    const since = Number(url.searchParams.get('since') || 0);
    return sendJson(res, 200, readEvents(key, root, since));
  }
  if (req.method === 'GET' && url.pathname === '/monitor/shot') {
    return serveShot(res, url.searchParams.get('key') || '', url.searchParams.get('root') || '', url.searchParams.get('n') || '');
  }
  // Storage management (loopback only, like the reads above).
  if (req.method === 'POST' && url.pathname === '/monitor/move') {
    return readJsonBody(req).then((b) => {
      const to = b.to === 'perm' ? 'perm' : 'tmp';
      const from = b.from === 'perm' ? 'perm' : 'tmp';
      if (!b.name) return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'name required' } });
      return sendJson(res, 200, moveSession(String(b.name), from, to));
    });
  }
  if (req.method === 'POST' && url.pathname === '/monitor/delete') {
    return readJsonBody(req).then((b) => {
      const root = b.root === 'perm' ? 'perm' : 'tmp';
      if (!b.name) return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'name required' } });
      return sendJson(res, 200, deleteSession(String(b.name), root));
    });
  }
  if (req.method === 'POST' && url.pathname === '/monitor/clear') {
    return readJsonBody(req).then((b) => {
      const root = b.root === 'perm' ? 'perm' : 'tmp';
      return sendJson(res, 200, clearRoot(root));
    });
  }

  // OAuth 2.1 authorization server (discovery, DCR, authorize/consent, token).
  if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/oauth/')) {
    return void oauthHandle(req, res, url).then((handled) => {
      if (!handled) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown path.' } });
    });
  }

  // MCP endpoint (OAuth-protected) — the tools any agent drives the browser with.
  if (url.pathname === '/mcp') {
    return void mcpHandle(req, res, url, { relay: relayCommand, requireToken: validateToken, wwwAuthenticate });
  }

  // Capability platform web UI: Modules, Rule Builder, module pages, popup nav.
  if (url.pathname.startsWith('/modules') || url.pathname.startsWith('/rules') || url.pathname === '/config' || url.pathname === '/bridge/nav' || url.pathname === '/artifacts/populate') {
    return void uiRoutes(req, res, url).then((handled) => {
      if (!handled) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown path.' } });
    }).catch((e) => sendJson(res, 500, { error: { code: 'UI_ERROR', message: String(e && e.message) } }));
  }

  // Bridge management for the extension popup (loopback only).
  if (req.method === 'GET' && url.pathname === '/bridge/status') {
    return sendJson(res, 200, { pairing: pairingStatus(), agents: listAgents(), pending: listPending(), stale: listStale(), browsers: listBrowsers(connectedBrowserIds()), activeBrowser: state.activeBrowser, agentConnected: agentConnected() });
  }
  if (req.method === 'POST' && url.pathname === '/bridge/revoke') {
    return readJsonBody(req).then((b) => sendJson(res, 200, b.client_id ? revokeAgent(String(b.client_id)) : { ok: false, error: 'client_id required' }));
  }
  if (req.method === 'POST' && url.pathname === '/bridge/remove') {
    return readJsonBody(req).then((b) => sendJson(res, 200, b.client_id ? removeClient(String(b.client_id)) : { ok: false, error: 'client_id required' }));
  }
  if (req.method === 'POST' && url.pathname === '/bridge/unpair') {
    return readJsonBody(req).then((b) => { unpairBrowser(b && b.browserId ? String(b.browserId) : null); notifyActive(); return sendJson(res, 200, { ok: true }); });
  }
  // Choose which linked browser receives relayed commands ("use THIS browser").
  if (req.method === 'POST' && url.pathname === '/bridge/activate') {
    return readJsonBody(req).then((b) => { const r = b && b.browserId ? setActiveBrowser(String(b.browserId)) : { ok: false, error: 'browserId required' }; notifyActive(); return sendJson(res, 200, r); });
  }

  if (url.pathname === COMMAND_PATH) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only.' } });
    }
    return handleCommandRequest(req, res);
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown path.' } });
});

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Explicitly no CORS headers — browsers cannot read cross-origin responses.
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Read a small JSON POST body (for the storage-management endpoints).
function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 1_000_000) { req.destroy(); resolve({}); return; }
      buf += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function handleCommandRequest(req, res) {
  let size = 0;
  const chunks = [];
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: { code: 'TOO_LARGE', message: 'Request body too large.' } });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid JSON body.' } });
    }
    if (!parsed || typeof parsed.method !== 'string') {
      return sendJson(res, 400, {
        error: { code: 'BAD_REQUEST', message: 'Body must include a string "method".' },
      });
    }

    if (!agentConnected()) {
      return sendJson(res, 503, {
        error: { code: 'NO_AGENT', message: 'No active browser connected to the bridge.' },
      });
    }

    // Build the command frame the extension expects.
    const id = parsed.id != null ? String(parsed.id) : nextId();
    const frame = {
      id,
      method: parsed.method,
      params: parsed.params || {},
    };
    // Auth is the pairing signature only (no bearer access code). Sign the frame
    // with the shared pairing key; the extension verifies it before executing.
    signFrame(frame);

    try {
      const reply = await relayToAgent(frame);
      // The reply already has {id, result} or {id, error}; pass it through.
      const status = reply && reply.error ? 200 : 200;
      return sendJson(res, status, reply);
    } catch (e) {
      return sendJson(res, 504, {
        id,
        error: { code: 'TIMEOUT', message: String((e && e.message) || e) },
      });
    }
  });

  req.on('error', () => {
    if (!aborted) sendJson(res, 400, { error: { code: 'REQ_ERROR', message: 'Request error.' } });
  });
}

// Relay a command to the extension and return its result (throws on error).
// Used by the MCP tools. Signs the frame with the pairing key when paired.
async function relayCommand(method, params) {
  if (!agentConnected()) {
    throw new Error('No active browser connected to the bridge.');
  }
  const frame = signFrame({ id: nextId(), method, params: params || {} });
  const reply = await relayToAgent(frame);
  if (reply && reply.error) {
    const e = new Error(reply.error.message || 'command error');
    e.code = reply.error.code;
    throw e;
  }
  return reply ? reply.result : null;
}

// Send a frame to the extension agent and await the correlated reply.
function relayToAgent(frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(frame.id);
      reject(new Error(`No reply within ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);

    pending.set(frame.id, { resolve, reject, timer });

    try {
      const ws = activeSocket();
      if (!ws) throw new Error('No active browser connected.');
      ws.send(JSON.stringify(frame));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(frame.id);
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket server (extension agent)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host;
  const origin = req.headers.origin;
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${host || '127.0.0.1'}`).pathname;
  } catch {
    /* fall through to reject */
  }

  if (pathname !== AGENT_PATH || !isLoopbackHostHeader(host) || !wsOriginAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Tell every linked browser whether IT is the active one (so popups/badges update
// the instant the active browser changes).
function notifyActive() {
  for (const [bid, ws] of agentSockets) sendToOneAgent(ws, { type: 'active', active: state.activeBrowser === bid, activeBrowser: state.activeBrowser });
}
// Let OAuth push the pending-request count so every linked browser badges its icon
// (auth is bridge-wide, not tied to one browser).
configureOAuth({ notifyPending: (n) => broadcastToAgents({ type: 'pending', count: n }) });

wss.on('connection', (ws) => {
  log('extension agent connected');
  legacySocket = ws; // fallback target until (unless) it identifies via hello/pair
  sendToOneAgent(ws, { type: 'pending', count: listPending().length }); // sync the badge on connect

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed frames from the agent
    }
    if (!msg) return;
    // Identity frame: learn which browser this socket is. Map it, migrate a legacy
    // pairing onto it if needed, and tell it whether it's the active browser.
    if (msg.type === 'hello') {
      const bid = typeof msg.browserId === 'string' && msg.browserId ? msg.browserId : null;
      if (bid) {
        ws._browserId = bid;
        adoptLegacyForBrowser(bid, msg.browserName);
        touchBrowser(bid, msg.browserName);
        agentSockets.set(bid, ws);
        sendToOneAgent(ws, { type: 'active', active: state.activeBrowser === bid, activeBrowser: state.activeBrowser });
      }
      return;
    }
    // Pairing handshake: extension sends its ECDH public key (+ its browser id);
    // we derive the shared HMAC key for THAT browser and return ours.
    if (msg.type === 'pair_init' && typeof msg.pub === 'string') {
      try {
        const bid = typeof msg.browserId === 'string' && msg.browserId ? msg.browserId : (ws._browserId || null);
        const pub = pairInit(msg.pub, bid, msg.browserName);
        if (bid) { ws._browserId = bid; agentSockets.set(bid, ws); }
        ws.send(JSON.stringify({ type: 'pair_ack', pub }));
        if (bid) sendToOneAgent(ws, { type: 'active', active: state.activeBrowser === bid, activeBrowser: state.activeBrowser });
        log('paired with browser', bid || '(legacy)');
      } catch (e) { log('pair error:', e && e.message); }
      return;
    }
    // Unsolicited monitor events (no id) are written to a tmp session dir.
    if (msg.type === 'monitor_event') {
      writeMonitorEvent(msg);
      return;
    }
    // Agent control frames (hello, etc.) have no id we track.
    if (msg.id == null) return;
    const entry = pending.get(String(msg.id));
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(String(msg.id));
      entry.resolve(msg);
    }
  });

  ws.on('close', () => {
    if (ws._browserId && agentSockets.get(ws._browserId) === ws) agentSockets.delete(ws._browserId);
    if (legacySocket === ws) legacySocket = null;
    // No browser recording anymore if none are connected → reset the tray.
    if (!agentSockets.size) { liveSessions.clear(); trayRefresh(); }
    log('extension agent disconnected', ws._browserId || '');
  });

  ws.on('error', (e) => {
    log('agent socket error:', e && e.message);
  });
});

// Basic keepalive ping to all connected agents so dead sockets are detected.
setInterval(() => {
  for (const ws of agentSockets.values()) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }
}, 20000);

// ---------------------------------------------------------------------------
// Monitor event writer — dumps a monitored tab's stream to a tmp session dir:
//   <os.tmpdir()>/ai-browser-bridge/<sessionKey>/
//     events.jsonl        one JSON line per event (network/navigation/session)
//     screenshots/NNNNN.jpg   screenshot frames (referenced by path in events)
//     meta.json           {sessionKey, tabId, startedAt, lastEventAt, counts}
// This is the file an AI reads to review what the user browsed.
// ---------------------------------------------------------------------------
// Two storage classes:
//   tmp  — OS temp dir; cleared on reboot (scratch recordings).
//   perm — <project>/browser-bridge/recordings; survives reboot.
const MON_ROOTS = {
  tmp: join(tmpdir(), 'ai-browser-bridge'),
  perm: process.env.BRIDGE_PERM_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'recordings'),
};
const ROOT_KEYS = ['tmp', 'perm'];
const shotCounters = new Map(); // sessionKey -> int
const sessionMeta = new Map(); // sessionKey -> {startedAt, count, ...}
const sessionRoot = new Map(); // sessionKey -> 'tmp'|'perm' — where LIVE events go now
const liveSessions = new Set(); // sessionKeys currently recording (for the tray)
function trayRefresh() { setTrayState(liveSessions.size ? 'recording' : 'idle'); }

const safeName = (k) => String(k).replace(/[^a-z0-9._-]/gi, '_');
function sessionDirFor(key, root = 'tmp') {
  return join(MON_ROOTS[root] || MON_ROOTS.tmp, safeName(key));
}

// Recursively sum the byte size of a directory (0 if missing).
function dirBytes(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      total += st.isDirectory() ? dirBytes(p) : st.size;
    }
  } catch { /* missing */ }
  return total;
}

function usageByRoot() {
  const u = {};
  for (const root of ROOT_KEYS) u[root] = dirBytes(MON_ROOTS[root]);
  return u;
}

// Move a directory across roots — plain rename when possible, copy+delete when
// the roots live on different volumes (tmp is often a separate filesystem).
function moveDir(src, dst) {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  return true;
}

// Relocate a live session's dir to a new root (extension Tmp/Perm toggle).
function relocateSession(key, from, to) {
  if (from === to) return;
  try { moveDir(sessionDirFor(key, from), sessionDirFor(key, to)); } catch (e) { log('relocate error:', e && e.message); }
}

function writeMonitorEvent(ev) {
  const key = ev.sessionKey;
  if (!key) return;

  // Storage class handling. The Research module's default (bridge-owned) wins;
  // ev.storage from the extension is the legacy fallback until the ext refactor.
  if (ev.kind === 'session' && ev.event === 'start') {
    const r = state.artifacts.research || {};
    let origin = null; try { origin = new URL(ev.url).origin; } catch {}
    const perOrigin = origin && r.storage && r.storage[origin];
    sessionRoot.set(key, (perOrigin || r.storageDefault || ev.storage) === 'perm' ? 'perm' : 'tmp');
    liveSessions.add(key); trayRefresh();
  } else if (ev.kind === 'session' && ev.event === 'stop') {
    liveSessions.delete(key); trayRefresh();
  } else if (ev.kind === 'storage' && (ev.storage === 'perm' || ev.storage === 'tmp')) {
    // Extension Tmp/Perm toggle on a live tab: relocate and keep recording there.
    relocateSession(key, sessionRoot.get(key) || 'tmp', ev.storage);
    sessionRoot.set(key, ev.storage);
    return; // control event — nothing to append
  }

  const root = sessionRoot.get(key) || 'tmp';
  const dir = sessionDirFor(key, root);
  try {
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    let rec = ev;
    if (ev.kind === 'screenshot' && typeof ev.dataUrl === 'string') {
      const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(ev.dataUrl);
      if (m) {
        const n = (shotCounters.get(key) || 0) + 1;
        shotCounters.set(key, n);
        const ext = /png/i.test(m[1]) ? 'png' : 'jpg';
        const file = join(dir, 'screenshots', String(n).padStart(5, '0') + '.' + ext);
        writeFileSync(file, Buffer.from(m[2], 'base64'));
        rec = { kind: 'screenshot', ts: ev.ts, tabId: ev.tabId, url: ev.url, file };
      }
    }
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n');

    const meta = sessionMeta.get(key) || { startedAt: ev.ts, count: 0 };
    meta.count += 1;
    meta.lastEventAt = ev.ts;
    meta.tabId = ev.tabId;
    meta.storage = root;
    // Tab identity for display (favicon + title), carried on session/nav/meta events.
    if (ev.title) meta.title = ev.title;
    if (ev.favIconUrl) meta.favIconUrl = ev.favIconUrl;
    if (ev.url) meta.url = ev.url;
    sessionMeta.set(key, meta);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ sessionKey: key, ...meta }, null, 2));

    if (meta.count === 1) log(`monitor session started: ${dir}`);
  } catch (e) {
    log('monitor write error:', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Dashboard + monitor read endpoints (loopback only)
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const safeKey = (k) => String(k).replace(/[^a-z0-9._-]/gi, '_');

function listSessions() {
  const out = [];
  for (const root of ROOT_KEYS) {
    const base = MON_ROOTS[root];
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const metaPath = join(dir, 'meta.json');
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
        out.push({
          id: root + ':' + name, root, name,
          sessionKey: name, tabId: meta.tabId,
          title: meta.title || '', favIconUrl: meta.favIconUrl || '', url: meta.url || '',
          startedAt: meta.startedAt, lastEventAt: meta.lastEventAt,
          count: meta.count || 0, bytes: dirBytes(dir),
          active: monitorActive(name) && (sessionRoot.get(name) || 'tmp') === root,
        });
      } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
}

// A session is "active" if the meta was touched in the last 15s.
function monitorActive(name) {
  const m = sessionMeta.get(name);
  return !!(m && m.lastEventAt && Date.now() - m.lastEventAt < 15000);
}

// Resolve which root actually holds a session (prefer the requested one).
function rootForKey(key, preferred) {
  if (preferred && existsSync(sessionDirFor(key, preferred))) return preferred;
  for (const root of ROOT_KEYS) if (existsSync(sessionDirFor(key, root))) return root;
  return preferred || 'tmp';
}

function readEvents(key, root, since) {
  const dir = sessionDirFor(key, rootForKey(key, root));
  const ev = join(dir, 'events.jsonl');
  if (!existsSync(ev)) return { events: [], total: 0 };
  const lines = readFileSync(ev, 'utf8').split('\n').filter(Boolean);
  const start = Number.isFinite(since) && since > 0 ? since : 0;
  const events = lines.slice(start).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { events, total: lines.length };
}

function serveShot(res, key, root, n) {
  const file = String(n).replace(/[^0-9]/g, '');
  const useRoot = rootForKey(key, root);
  const base = MON_ROOTS[useRoot];
  const dir = join(base, safeName(key), 'screenshots');
  for (const ext of ['jpg', 'png']) {
    const p = join(dir, file.padStart(5, '0') + '.' + ext);
    if (existsSync(p) && p.startsWith(base)) {
      const buf = readFileSync(p);
      res.writeHead(200, { 'content-type': ext === 'png' ? 'image/png' : 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No such screenshot.' } });
}

// Bridge-side move: relocate a session's data-so-far to the other root. If it's
// still recording (live root === from), we deliberately DON'T change sessionRoot,
// so continued events recreate the original entry → the tab shows two entries.
function moveSession(name, from, to) {
  const src = sessionDirFor(name, from);
  if (!existsSync(src)) return { ok: false, error: 'source not found' };
  let dstName = name;
  if (existsSync(sessionDirFor(dstName, to))) dstName = name + '--moved-' + Date.now();
  moveDir(src, sessionDirFor(dstName, to));
  // If this was the frozen (non-live) copy, forget its in-memory state.
  if ((sessionRoot.get(name) || 'tmp') !== from) { /* nothing live to keep */ }
  return { ok: true, name: dstName, root: to };
}

function deleteSession(name, root) {
  const dir = sessionDirFor(name, root);
  if (!existsSync(dir)) return { ok: false, error: 'not found' };
  rmSync(dir, { recursive: true, force: true });
  if ((sessionRoot.get(name) || 'tmp') === root) {
    sessionMeta.delete(name); shotCounters.delete(name); sessionRoot.delete(name);
  }
  return { ok: true };
}

function clearRoot(root) {
  const base = MON_ROOTS[root];
  let removed = 0;
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      try { rmSync(join(base, name), { recursive: true, force: true }); removed++; } catch {}
      if ((sessionRoot.get(name) || 'tmp') === root) { sessionMeta.delete(name); shotCounters.delete(name); sessionRoot.delete(name); }
    }
  }
  return { ok: true, removed };
}

function serveDashboard(res) {
  try {
    const html = readFileSync(join(__dirname, 'dashboard.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  } catch {
    return sendJson(res, 500, { error: { code: 'NO_DASHBOARD', message: 'dashboard.html missing.' } });
  }
}

// ---------------------------------------------------------------------------
// Capability platform: wire the rule engine + module loader.
// ---------------------------------------------------------------------------
configureRules({ relayCommand });
const moduleCtx = {
  relayCommand, state, save, resolveTabUrl,
  setDestinationContents, refreshModuleDestinations,
  monitor: { listSessions, readEvents, moveSession, deleteSession, clearRoot, usageByRoot, MON_ROOTS },
};
configureModules(moduleCtx);
await loadModules();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function log(...args) {
  // eslint-disable-next-line no-console
  console.log(`[bridge ${new Date().toISOString()}]`, ...args);
}

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`  extension WS: ws://${HOST}:${PORT}${AGENT_PATH}`);
  log(`  tools POST:   http://${HOST}:${PORT}${COMMAND_PATH}`);
  log(`  perm storage: ${MON_ROOTS.perm}`);
  // Optional menubar tray (blue running / green recording). Never fatal.
  startTray({ dashboardUrl: `http://${HOST}:${PORT}/`, onQuit: () => { stopTray(); process.exit(0); } })
    .then((ok) => log(ok ? 'tray icon started' : 'tray icon unavailable (bridge runs without it)'));
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use — is the bridge already running?`);
  } else {
    log('server error:', e && e.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  log('shutting down');
  stopTray();
  for (const { timer, reject } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Bridge shutting down.'));
  }
  wss.close();
  server.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 1000);
});
