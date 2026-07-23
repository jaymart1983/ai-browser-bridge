// background.js — MV3 service worker (ES module).
//
// RESPONSIBILITIES
//   * Trust anchor with the bridge is the "Link" pairing: an ECDH handshake
//     derives a shared HMAC key (chrome.storage.local); the bridge signs every
//     relayed command and we verify that signature. There is NO access code.
//     Agents authenticate to the bridge over OAuth; the bridge relays to us.
//   * Ensures a single offscreen document exists to host the persistent
//     WebSocket to the local bridge (service workers cannot hold a long-lived
//     socket reliably — they are torn down after ~30s idle).
//   * Routes bridge commands: the offscreen doc forwards each inbound WS message
//     here; we execute it against chrome.tabs / chrome.scripting and return a
//     response, which the offscreen doc writes back over the WS.
//   * Uses a chrome.alarms keepalive to periodically wake up and make sure the
//     offscreen document + WebSocket are alive, because the SW itself is
//     ephemeral and cannot run its own timer across suspensions.
//
// WHY AN OFFSCREEN DOCUMENT?
//   MV3 replaced persistent background pages with ephemeral service workers.
//   A WebSocket opened directly in the SW dies when the SW is suspended. An
//   offscreen document is a hidden top-level document that the browser keeps
//   alive; it holds the socket and relays messages to/from the SW via
//   chrome.runtime messaging. The alarm-based keepalive resurrects both after
//   the SW is killed.

const VERSION = '0.1.0';
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787/agent';

// Auth model: pairing ONLY. The one-time "Link" ECDH handshake derives a shared
// HMAC key; the bridge signs every relayed command frame with it and the
// extension verifies that signature (verifyFrameMac) before executing. There is
// NO access code / bearer password — agents authenticate to the bridge over
// OAuth; the extension trusts the bridge solely via the Link pairing.

// Keepalive alarm period. The spec asks for 25s; Chrome may clamp very short
// alarm periods (historically to a 30s floor for unpacked extensions), which is
// fine — the offscreen document runs its own faster reconnect loop, and this
// alarm is only a coarse "make sure everything is still alive" heartbeat.
const KEEPALIVE_ALARM = 'bridge-keepalive';
const KEEPALIVE_PERIOD_MIN = 25 / 60;

// Storage keys. Tab policy (allow/storage) is bridge-owned (rule engine); the
// extension keeps only the pairing key + the browser primitives.
const K_PAIR_KEY = 'pairKeyHex'; // ECDH-derived HMAC key (hex) shared with the bridge
const K_BRIDGE_URL = 'bridgeUrl'; // string
const K_BROWSER_ID = 'browserId'; // stable per-install id so the bridge can tell browsers apart
const K_BROWSER_NAME = 'browserName'; // friendly label (Chrome / Brave / Edge / …)

// Best-effort browser name for the linked-browsers list in the bridge.
function detectBrowserName() {
  try {
    const ua = (self.navigator && navigator.userAgent) || '';
    if (self.navigator && navigator.brave) return 'Brave';
    if (/\bEdg\//.test(ua)) return 'Edge';
    if (/\bOPR\//.test(ua)) return 'Opera';
    if (/\bVivaldi/.test(ua)) return 'Vivaldi';
    if (/\bChrome\//.test(ua)) return 'Chrome';
    return 'Browser';
  } catch { return 'Browser'; }
}
// Ensure this install has a stable id + name (used to identify it to the bridge).
async function ensureBrowserIdentity() {
  const cur = await chrome.storage.local.get([K_BROWSER_ID, K_BROWSER_NAME]);
  const patch = {};
  if (typeof cur[K_BROWSER_ID] !== 'string' || !cur[K_BROWSER_ID]) {
    const rnd = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36));
    patch[K_BROWSER_ID] = 'br_' + rnd.slice(0, 16);
  }
  if (typeof cur[K_BROWSER_NAME] !== 'string' || !cur[K_BROWSER_NAME]) patch[K_BROWSER_NAME] = detectBrowserName();
  if (Object.keys(patch).length) await setLocal(patch);
  return { id: patch[K_BROWSER_ID] || cur[K_BROWSER_ID], name: patch[K_BROWSER_NAME] || cur[K_BROWSER_NAME] };
}

// Capabilities advertised by `status`.
const CAPABILITIES = [
  'status',
  'tabs.list',
  'tab.navigate',
  'tab.create',
  'tab.activate',
  'tab.close',
  'page.read',
  'page.eval',
  'page.fetch',
  'page.exec',
  'page.screenshot',
  'monitor.start',
  'monitor.stop',
  'monitor.list',
];

// ---------------------------------------------------------------------------
// Live connection state (in-memory; not persisted).
// ---------------------------------------------------------------------------
let wsConnected = false;
let pendingAuth = 0; // count of agents awaiting your approval (drives the top-left badge)

// Tabs currently being recorded: tabId -> { sessionKey, startedAt, eventCount, ... }.
// Declared early so updateIcon() (called during bootstrap, before the monitor
// section below runs) can read monitored.size without hitting the TDZ.
const monitored = new Map();
let iconPhase = 0; // toggled each captured frame to animate the recording icon

// ---------------------------------------------------------------------------
// Toolbar icon: gray car when the bridge WS is disconnected, red car when
// connected — a live "is everything wired up?" indicator. Drawn at runtime with
// OffscreenCanvas so we ship no binary image files.
// ---------------------------------------------------------------------------
// Trace an arrow (up/down) centered at grid-x `cx` on a 16-unit grid.
function arrowPath(ctx, cx, dir, s, mag = 1) {
  // `mag` scales the arrow about the vertical center (8) so we can animate the
  // two arrows at different sizes (left small / right big, then swapped).
  const cy = 8;
  const shaftHW = 1.3 * mag; // shaft half-width
  const headHW = 3.2 * mag; // arrowhead half-width
  const top = cy + (2.4 - cy) * mag;
  const bot = cy + (13.6 - cy) * mag;
  const headLen = 4.4 * mag;
  ctx.beginPath();
  if (dir === 'down') {
    const hy = bot - headLen; // where the head meets the shaft
    ctx.moveTo((cx - shaftHW) * s, top * s);
    ctx.lineTo((cx - shaftHW) * s, hy * s);
    ctx.lineTo((cx - headHW) * s, hy * s);
    ctx.lineTo(cx * s, bot * s);
    ctx.lineTo((cx + headHW) * s, hy * s);
    ctx.lineTo((cx + shaftHW) * s, hy * s);
    ctx.lineTo((cx + shaftHW) * s, top * s);
  } else {
    const hy = top + headLen;
    ctx.moveTo((cx - shaftHW) * s, bot * s);
    ctx.lineTo((cx - shaftHW) * s, hy * s);
    ctx.lineTo((cx - headHW) * s, hy * s);
    ctx.lineTo(cx * s, top * s);
    ctx.lineTo((cx + headHW) * s, hy * s);
    ctx.lineTo((cx + shaftHW) * s, hy * s);
    ctx.lineTo((cx + shaftHW) * s, bot * s);
  }
  ctx.closePath();
}

// Data-transfer glyph: a SOLID down-arrow (left) + an OUTLINED up-arrow (right).
// `phase` (0/1) swaps which arrow is larger, so alternating it animates flow.
function drawTransferIcon(size, color, phase = 0, pending = 0) {
  let canvas;
  try {
    canvas = new OffscreenCanvas(size, size);
  } catch {
    return null; // OffscreenCanvas unavailable
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const s = size / 16; // design on a 16-unit grid, scale up
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const magL = phase ? 1.0 : 0.72; // left small→big
  const magR = phase ? 0.72 : 1.0; // right big→small
  // Left: down arrow, filled.
  arrowPath(ctx, 5, 'down', s, magL);
  ctx.fill();
  // Right: up arrow, outlined.
  ctx.lineWidth = Math.max(1, 1.4 * s);
  arrowPath(ctx, 11, 'up', s, magR);
  ctx.stroke();
  // Pending-auth indicator: a small dot in the TOP-LEFT corner (an agent is
  // waiting for approval). White ring so it reads on any toolbar theme.
  if (pending > 0) {
    const cx = 3 * s, cy = 3 * s, r = 2.7 * s;
    ctx.beginPath(); ctx.arc(cx, cy, r + Math.max(0.7, 0.7 * s), 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#d29922'; ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

// Icon color: gray = bridge off, blue = connected & idle, green = recording.
function iconColor() {
  if (!wsConnected) return '#888888';
  return monitored.size ? '#2e9e44' : '#3b82f6';
}

// Flip the arrows one step — called on each captured frame while recording, so
// motion tracks real activity (reliable under MV3's sleepy service worker).
function animateIconTick() {
  if (!monitored.size) return;
  iconPhase ^= 1;
  updateIcon();
}

function updateIcon() {
  const color = iconColor();
  const imageData = {};
  for (const size of [16, 32, 48]) {
    const img = drawTransferIcon(size, color, iconPhase, pendingAuth);
    if (img) imageData[size] = img;
  }
  if (Object.keys(imageData).length && chrome.action && chrome.action.setIcon) {
    chrome.action.setIcon({ imageData }).catch(() => {});
    const n = monitored.size;
    chrome.action
      .setTitle({
        title: `AI Browser Bridge — ${wsConnected ? 'bridge connected' : 'bridge OFF'}` +
          (pendingAuth ? ` · ${pendingAuth} agent${pendingAuth === 1 ? '' : 's'} awaiting approval` : '') +
          (n ? ` · recording ${n} tab${n === 1 ? '' : 's'}` : ''),
      })
      .catch(() => {});
  }
  // Badge: how many tabs are recording right now (blank when none).
  if (chrome.action && chrome.action.setBadgeText) {
    const n = monitored.size;
    chrome.action.setBadgeText({ text: n ? String(n) : '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#2e9e44' }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Small storage helpers
// ---------------------------------------------------------------------------
async function getLocal(key, dflt) {
  const obj = await chrome.storage.local.get(key);
  return key in obj ? obj[key] : dflt;
}
async function setLocal(obj) {
  await chrome.storage.local.set(obj);
}
async function getSession(key, dflt) {
  const obj = await chrome.storage.session.get(key);
  return key in obj ? obj[key] : dflt;
}

// ---------------------------------------------------------------------------
// First-install setup. No credentials are generated — the trust anchor is the
// one-time "Link" pairing the user performs from the popup.
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  try { await ensureDefaults(); } catch (e) { console.error('[bridge] onInstalled setup failed', e); }
  await bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((e) => console.error('[bridge] onStartup failed', e));
});

// Also bootstrap on cold SW start (module top-level runs on every wake).
bootstrap().catch((e) => console.error('[bridge] bootstrap failed', e));

async function ensureDefaults() {
  const cur = await chrome.storage.local.get([K_BRIDGE_URL]);
  if (typeof cur[K_BRIDGE_URL] !== 'string') await setLocal({ [K_BRIDGE_URL]: DEFAULT_BRIDGE_URL });
  await ensureBrowserIdentity(); // stable id + name available before the WS says hello
}

async function bootstrap() {
  updateIcon(); // reflect current (likely disconnected) state immediately
  await ensureDefaults();
  await ensureOffscreen();
  await ensureKeepaliveAlarm();
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
const OFFSCREEN_PATH = 'offscreen.html';

async function hasOffscreen() {
  // getContexts is the reliable way to detect an existing offscreen document.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return contexts.length > 0;
  }
  return false;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // There is no dedicated "WebSocket" reason in the offscreen API; WORKERS
      // is the closest fit for "keep a background connection/processing alive".
      // Documented caveat: this is a pragmatic choice, not a perfect semantic
      // match, and is called out in the README.
      reasons: ['WORKERS'],
      justification:
        'Maintain a persistent local WebSocket to the AI bridge on 127.0.0.1.',
    })
    .catch((e) => {
      // A race can throw "Only a single offscreen document may be created".
      if (!String(e && e.message).includes('single offscreen')) throw e;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
  // Push the current bridge URL to the new document.
  const bridgeUrl = await getLocal(K_BRIDGE_URL, DEFAULT_BRIDGE_URL);
  await sendToOffscreen({ type: 'CONFIG', bridgeUrl }).catch(() => {});
}

async function ensureKeepaliveAlarm() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_PERIOD_MIN,
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Waking here revives the SW; make sure the offscreen doc + socket are alive.
  (async () => {
    await ensureOffscreen();
    await sendToOffscreen({ type: 'PING' }).catch(() => {});
  })().catch((e) => console.error('[bridge] keepalive failed', e));
});

// ---------------------------------------------------------------------------
// Messaging between SW <-> offscreen <-> popup
// ---------------------------------------------------------------------------

// Send a message that only the offscreen document answers. runtime.sendMessage
// reaches every extension page (offscreen + popup) but not the SW itself; the
// popup ignores these control messages by type.
function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Central message hub.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Command relayed from the offscreen WebSocket.
  if (msg.type === 'BRIDGE_COMMAND') {
    handleCommand(msg.payload)
      .then((resp) => sendResponse(resp))
      .catch((e) =>
        sendResponse({
          id: msg.payload && msg.payload.id,
          error: { code: 'INTERNAL', message: String(e && e.message) },
        })
      );
    return true; // async
  }

  // Connection status pushed from offscreen.
  if (msg.type === 'WS_STATUS') {
    wsConnected = !!msg.connected;
    if (!wsConnected) pendingAuth = 0; // clear the badge when the bridge drops
    if (wsConnected) { sendIdentity(); maybeAutopair(); } // identify + hands-free link (embedder token)
    updateIcon();
    return; // no response needed
  }

  // Pending-auth count pushed from the bridge → top-left icon badge.
  if (msg.type === 'PENDING') {
    pendingAuth = Math.max(0, msg.count | 0);
    updateIcon();
    return;
  }

  // Pairing handshake reply from the bridge (relayed via offscreen).
  if (msg.type === 'PAIR_ACK' && typeof msg.pub === 'string') {
    finishPairing(msg.pub).catch(() => {});
    return;
  }

  // Passive capture relayed from a monitored tab's content script. We trust the
  // SENDER's tab id (not any id in the message) and only forward if monitored.
  if (msg.type === 'MONITOR_CAPTURE') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === 'number' && monitored.has(tabId) && msg.event) {
      emitMonitor(tabId, msg.event);
    }
    return;
  }

  // User activity in a monitored tab → schedule one settled screenshot.
  if (msg.type === 'MONITOR_ACTIVITY') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === 'number' && monitored.has(tabId)) scheduleActivityShot(tabId);
    return;
  }

  // Popup <-> SW control messages.
  if (msg.type === 'POPUP') {
    handlePopup(msg)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ error: String(e && e.message) }));
    return true; // async
  }
});

// ---------------------------------------------------------------------------
// Command router (handles messages from the bridge WS)
// ---------------------------------------------------------------------------
async function handleCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.id === 'undefined') {
    return { id: (cmd && cmd.id) ?? null, error: { code: 'BAD_REQUEST', message: 'Missing id' } };
  }
  const { id, method, params = {} } = cmd;

  try {
    switch (method) {
      case 'status':
        return { id, result: await doStatus() };

      case 'tabs.list':
        await requireAuth(cmd);
        return { id, result: await doTabsList() };

      // Policy (which tabs/actions are allowed) is now enforced BRIDGE-SIDE by
      // the rule engine. The extension only verifies the pairing signature
      // (requireAuth) and executes.
      case 'tab.navigate':
        await requireAuth(cmd);
        return { id, result: await doTabNavigate(params) };

      case 'tab.create':
        await requireAuth(cmd);
        return { id, result: await doTabCreate(params) };

      case 'tab.activate':
        await requireAuth(cmd);
        return { id, result: await doTabActivate(params) };

      case 'tab.close':
        await requireAuth(cmd);
        return { id, result: await doTabClose(params) };

      case 'page.read':
        await requireAuth(cmd);
        return { id, result: await doPageRead(params) };

      case 'page.eval':
        await requireAuth(cmd);
        return { id, result: await doPageEval(params) };

      // CSP-safe authenticated same-origin fetch (fixed injected function, no
      // eval) — works even on strict-CSP apps (CrowdStrike, Splunk, Slack).
      case 'page.fetch':
        await requireAuth(cmd);
        return { id, result: await doPageFetch(params) };

      // CSP-EXEMPT arbitrary code exec (chrome.userScripts when available, else
      // the eval path) — for extractors that must read an in-page token/CSRF
      // header before fetching on strict-CSP apps.
      case 'page.exec':
        await requireAuth(cmd);
        return { id, result: await doPageExec(params) };

      case 'page.screenshot':
        await requireAuth(cmd);
        return { id, result: await doPageScreenshot(params) };

      case 'monitor.start':
        await requireAuth(cmd);
        return { id, result: await monitorStart(params.tabId) };

      case 'monitor.stop':
        await requireAuth(cmd);
        return { id, result: await monitorStop(params.tabId) };

      case 'monitor.list':
        await requireAuth(cmd);
        return { id, result: monitorList() };

      default:
        return { id, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
    }
  } catch (e) {
    if (e && e.code) {
      return { id, error: { code: e.code, message: e.message } };
    }
    return { id, error: { code: 'INTERNAL', message: String(e && e.message) } };
  }
}

// A typed error so we can map to protocol error codes.
class CmdError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Bridge pairing (ECDH → shared HMAC key). Once paired, every command frame the
// bridge relays is signed with this key; we verify the signature instead of an
// access code. This is the trust anchor between the extension and the bridge.
// ---------------------------------------------------------------------------
let pairKeyHex = null;   // cached derived key
let pairEphemeral = null; // ECDH keypair held during an in-flight handshake

async function getPairKey() {
  if (pairKeyHex) return pairKeyHex;
  pairKeyHex = await getLocal(K_PAIR_KEY, null);
  return pairKeyHex;
}
const bufToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function hexToBuf(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a.buffer; }

// Canonical frame string — MUST match bridge/pairing.mjs exactly.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const canonFrame = (cmd) => cmd.id + '\n' + cmd.method + '\n' + stableStringify(cmd.params || {});

async function verifyFrameMac(cmd) {
  const keyHex = await getPairKey();
  if (!keyHex || !cmd || typeof cmd.mac !== 'string') return false;
  const key = await crypto.subtle.importKey('raw', hexToBuf(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonFrame(cmd)));
  return bufToHex(sig) === cmd.mac;
}

// autopair.json is written into the extension dir by an embedder (AI Analyst) that
// force-loads this extension; when present, its token lets us pair HANDS-FREE (no "Link"
// click). undefined = not yet loaded, null = none present, string = the token.
let autopairToken;
async function loadAutopairToken() {
  if (autopairToken !== undefined) return autopairToken;
  autopairToken = null;
  try {
    const r = await fetch(chrome.runtime.getURL('autopair.json'));
    if (r.ok) { const d = await r.json(); if (d && typeof d.token === 'string' && d.token) autopairToken = d.token; }
  } catch { /* no embedder token → manual Link only */ }
  return autopairToken;
}

// Kick off pairing: generate an ECDH keypair, send our public key to the bridge. Includes the
// embedder's autopair token when available (required by an embedder-run bridge).
async function startPairing() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  pairEphemeral = kp;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const { id, name } = await ensureBrowserIdentity();
  const frame = { type: 'pair_init', pub: bufToHex(raw), browserId: id, browserName: name };
  const tok = await loadAutopairToken();
  if (tok) frame.token = tok;
  sendToOffscreen({ type: 'WS_SEND', frame }).catch(() => {});
  return { ok: true };
}

// After connecting, auto-pair if we have an embedder token and aren't linked yet.
async function maybeAutopair() {
  if (await getPairKey()) return;         // already linked
  if (pairEphemeral) return;              // a handshake is already in flight
  if (!(await loadAutopairToken())) return; // no token → user must click Link
  startPairing().catch(() => {});
}

// Announce WHICH browser we are to the bridge (from the SW, where the id is
// reliably available), so the bridge maps this socket / migrates a legacy pairing.
// Sent on every (re)connect.
async function sendIdentity() {
  try {
    const { id, name } = await ensureBrowserIdentity();
    await sendToOffscreen({ type: 'WS_SEND', frame: { type: 'hello', role: 'extension', version: VERSION, browserId: id, browserName: name } });
  } catch { /* offscreen not ready; next connect will retry */ }
}

// Finish pairing: derive the shared key from the bridge's public key.
async function finishPairing(bridgePubHex) {
  if (!pairEphemeral) return;
  const bridgePub = await crypto.subtle.importKey('raw', hexToBuf(bridgePubHex), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: bridgePub }, pairEphemeral.privateKey, 256);
  const keyBuf = await crypto.subtle.digest('SHA-256', bits);
  pairKeyHex = bufToHex(keyBuf);
  await setLocal({ [K_PAIR_KEY]: pairKeyHex });
  pairEphemeral = null;
  updateIcon();
}

async function clearPairing() { pairKeyHex = null; pairEphemeral = null; await chrome.storage.local.remove(K_PAIR_KEY); }

// Authorize a command. The ONLY trust anchor is the Link pairing: the bridge
// signs every relayed frame with the shared HMAC key and we verify it. If this
// browser isn't linked yet, reject — the user must click Link in the popup.
async function requireAuth(cmd) {
  if (!(await getPairKey())) {
    throw new CmdError('UNAUTHORIZED', 'Browser is not linked to the bridge. Click "Link" in the extension.');
  }
  if (await verifyFrameMac(cmd)) return;
  throw new CmdError('UNAUTHORIZED', 'Missing or invalid bridge signature.');
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------
async function doStatus() {
  let tabCount = 0;
  try {
    tabCount = (await chrome.tabs.query({})).length;
  } catch {
    /* ignore */
  }
  return {
    running: true,
    version: VERSION,
    locked: !(await getPairKey()), // "locked" = not linked to the bridge yet
    tabCount,
    wsConnected,
    capabilities: CAPABILITIES,
  };
}

// Raw tab facts only — policy (allow/storage) is bridge-owned now.
async function doTabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    tabId: t.id,
    url: t.url || t.pendingUrl || '',
    title: t.title || '',
    favIconUrl: t.favIconUrl || '',
    active: !!t.active,
  }));
}

async function doTabNavigate(params) {
  const { tabId, url } = params;
  assertHttpLikeUrl(url);
  const tab = await chrome.tabs.update(tabId, { url });
  return { tabId: tab.id, url };
}

async function doTabCreate(params) {
  const { url, active } = params || {};
  const opts = { active: active === true };
  if (typeof url === 'string' && url) { assertHttpLikeUrl(url); opts.url = url; }
  const tab = await chrome.tabs.create(opts);
  // New tab defaults to allowed (no entry === allowed), consistent with policy.
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || url || '' };
}

async function doTabClose(params) {
  const { tabId } = params;
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  await chrome.tabs.remove(tabId);
  return { tabId, closed: true };
}

async function doTabActivate(params) {
  const { tabId } = params;
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab && typeof tab.windowId === 'number') {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* window focus best-effort */
    }
  }
  return { tabId, active: true };
}

async function doPageRead(params) {
  const { tabId, format = 'text' } = params;
  if (format !== 'text' && format !== 'html') {
    throw new CmdError('BAD_REQUEST', "format must be 'text' or 'html'.");
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fmt) => {
      if (fmt === 'html') return document.documentElement.outerHTML;
      return document.body ? document.body.innerText : '';
    },
    args: [format],
  });
  return { tabId, format, content: res ? res.result : '' };
}

async function doPageEval(params) {
  const { tabId, expression } = params;
  if (typeof expression !== 'string') {
    throw new CmdError('BAD_REQUEST', 'params.expression (string) is required.');
  }
  // Evaluate in the page's MAIN world so the expression sees the real page
  // globals. The result must be JSON-serializable (executeScript enforces
  // structured-clone-ability); we defensively coerce and surface eval errors.
  const [res] = await chrome.scripting.executeScript({
    world: 'MAIN',
    target: { tabId },
    // Async so the injected code can `await` a Promise result — this lets an
    // expression run same-origin fetches (e.g. the ACV search/Carfax APIs)
    // using the page's own logged-in credentials. chrome.scripting awaits the
    // returned promise before handing back the result.
    func: async (expr) => {
      try {
        // eslint-disable-next-line no-eval
        let value = (0, eval)(expr);
        if (value && typeof value.then === 'function') value = await value;
        // Ensure the value survives structured clone / JSON round-trip.
        return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
    args: [expression],
  });
  const out = res ? res.result : { ok: false, error: 'No result' };
  if (!out.ok) {
    throw new CmdError('EVAL_ERROR', out.error);
  }
  return { tabId, value: out.value };
}

// CSP-safe authenticated same-origin fetch. Runs a FIXED injected function
// (not eval) in the tab's MAIN world with the request passed as args, so it is
// never blocked by the page's Content-Security-Policy (`unsafe-eval`). This is
// the port of the old gateway's fetch_in_page: the tab's own fetch carries its
// cookies (credentials:'include'). Returns { ok, status, url, data } or a
// structured { ok:false, needsAuth?, error:{type,message} } the extractors
// branch on (login_redirect / http_4xx / fetch_error).
async function doPageFetch(params) {
  const { tabId, url, method = 'GET', headers = {}, body = null } = params || {};
  if (typeof tabId !== 'number' || typeof url !== 'string') {
    throw new CmdError('BAD_REQUEST', 'params.tabId (number) and params.url (string) are required.');
  }
  const [res] = await chrome.scripting.executeScript({
    world: 'MAIN',
    target: { tabId },
    func: async (req) => {
      try {
        const r = await fetch(req.url, {
          method: req.method || 'GET',
          headers: req.headers || {},
          body: req.body != null ? req.body : undefined,
          credentials: 'include',
          redirect: 'manual',
        });
        // An opaqueredirect (manual redirect) to a login page => not authenticated.
        if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
          return { ok: false, status: r.status, url: req.url, needsAuth: true, error: { type: 'login_redirect', message: 'Request was redirected (likely to sign-in).' } };
        }
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        let data;
        try { data = ct.includes('json') ? await r.json() : await r.text(); }
        catch { try { data = await r.text(); } catch { data = null; } }
        if (r.status === 401 || r.status === 403) {
          return { ok: false, status: r.status, url: r.url, needsAuth: true, data, error: { type: 'http_' + r.status, message: 'HTTP ' + r.status } };
        }
        if (!r.ok) {
          return { ok: false, status: r.status, url: r.url, data, error: { type: 'http_' + r.status, message: 'HTTP ' + r.status } };
        }
        return { ok: true, status: r.status, url: r.url, data };
      } catch (e) {
        return { ok: false, error: { type: 'fetch_error', message: String((e && e.message) || e) } };
      }
    },
    args: [{ url, method, headers, body }],
  });
  return res ? res.result : { ok: false, error: { type: 'no_result', message: 'No result from page.' } };
}

// CSP-EXEMPT code execution. The page's CSP governs `eval()` even in the MAIN
// world, so the eval-based page.eval fails on strict-CSP apps. chrome.userScripts
// injects code that is NOT subject to the page CSP. Prefer userScripts.execute
// (Chrome 135+); fall back to the eval path when it's unavailable so lenient
// sites still work. `code` is an async-function BODY that returns a value.
async function doPageExec(params) {
  const { tabId, code } = params || {};
  if (typeof tabId !== 'number' || typeof code !== 'string') {
    throw new CmdError('BAD_REQUEST', 'params.tabId (number) and params.code (string) are required.');
  }
  // The completion value of the injected classic script is its trailing
  // expression — so we END with the async IIFE (no top-level `return`, which
  // would be a syntax error in a classic script). userScripts.execute resolves
  // a thenable completion value before returning it.
  const wrapped = 'globalThis.__aibx = (async () => {\n' + code + '\n})(); __aibx;';
  // Preferred: chrome.userScripts.execute — CSP-exempt (Chrome 135+).
  try {
    if (chrome.userScripts && typeof chrome.userScripts.execute === 'function') {
      const results = await chrome.userScripts.execute({
        target: { tabId },
        world: 'MAIN',
        injectImmediately: true,
        js: [{ code: wrapped }],
      });
      const r = Array.isArray(results) ? results[0] : results;
      if (r && r.error) throw new CmdError('EVAL_ERROR', String((r.error && r.error.message) || r.error));
      if (r && Object.prototype.hasOwnProperty.call(r, 'result')) {
        let value = r.result;
        if (value && typeof value.then === 'function') value = await value;
        return { tabId, value: JSON.parse(JSON.stringify(value ?? null)) };
      }
      // Unexpected shape (API differs on this Chrome) → degrade to the eval path.
    }
  } catch (e) {
    if (e && e.code === 'EVAL_ERROR') throw e;
    // userScripts not permitted/available/mis-shaped → fall through.
  }
  // Fallback: eval in MAIN world (subject to page CSP — works on lenient sites).
  return doPageEval({ tabId, expression: '(async () => {\n' + code + '\n})()' });
}

async function doPageScreenshot(params) {
  const { tabId } = params;
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab grabs the *visible* tab of the given window. If the target
  // tab is not the active tab in its window the capture will be of whatever IS
  // visible there — documented caveat; callers should tab.activate first.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { tabId, dataUrl };
}

// ---------------------------------------------------------------------------
// Monitor mode — passively capture a tab AS THE USER BROWSES it (their own
// navigation; no automation), streaming events to the bridge which writes them
// to a tmp session dir for later/live review. Captures: JSON network responses
// (via an in-page fetch/XHR wrapper), navigations (with timing — useful for
// "what did I dwell on"), and periodic screenshots while the tab is visible.
// ---------------------------------------------------------------------------

function emitMonitor(tabId, payload) {
  const rec = monitored.get(tabId);
  if (!rec) return;
  rec.eventCount++;
  const frame = { type: 'monitor_event', sessionKey: rec.sessionKey, tabId, ts: Date.now(), ...payload };
  sendToOffscreen({ type: 'WS_SEND', frame }).catch(() => {});
}

// Injected into the page MAIN world: wrap fetch + XHR to observe responses.
// Self-contained (no closure over extension scope) — required by executeScript.
function __aibridgeCapture() {
  if (window.__aibridgeCaptureInstalled) return;
  window.__aibridgeCaptureInstalled = true;
  const MAX = 1000000;
  const post = (data) => { try { window.postMessage({ __aibridge: true, data }, '*'); } catch (e) {} };
  const of = window.fetch;
  if (of) {
    window.fetch = function () {
      const args = arguments;
      return of.apply(this, args).then((res) => {
        try {
          const ct = (res.headers && res.headers.get('content-type')) || '';
          const url = res.url || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url));
          if (String(ct).includes('json')) {
            res.clone().text().then((t) => post({ kind: 'network', url, status: res.status, contentType: ct, body: String(t).slice(0, MAX) })).catch(() => {});
          } else {
            post({ kind: 'network', url, status: res.status, contentType: ct });
          }
        } catch (e) {}
        return res;
      });
    };
  }
  const X = window.XMLHttpRequest;
  if (X && X.prototype) {
    const open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function (m, u) { this.__au = u; return open.apply(this, arguments); };
    X.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (String(ct).includes('json')) post({ kind: 'network', url: this.__au, status: this.status, contentType: ct, body: String(this.responseText || '').slice(0, MAX) });
          else post({ kind: 'network', url: this.__au, status: this.status, contentType: ct });
        } catch (e) {}
      });
      return send.apply(this, arguments);
    };
  }
}

// Injected into the ISOLATED content-script world: relay page messages to the SW.
function __aibridgeRelay() {
  if (window.__aibridgeRelayInstalled) return;
  window.__aibridgeRelayInstalled = true;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__aibridge !== true) return;
    try { chrome.runtime.sendMessage({ type: 'MONITOR_CAPTURE', event: d.data }); } catch (e) {}
  });
  // User-activity signals: the SW takes ONE settled, deduped screenshot after
  // each, instead of blindly every 4s. Scroll is coalesced to scroll-stop.
  const ping = (reason) => { try { chrome.runtime.sendMessage({ type: 'MONITOR_ACTIVITY', reason }); } catch (e) {} };
  document.addEventListener('click', () => ping('click'), true);
  let st;
  document.addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => ping('scroll'), 350); }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping('visible'); });
}

async function injectCapture(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: __aibridgeCapture });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: __aibridgeRelay });
  } catch (e) { /* tab not injectable (chrome://, etc.) */ }
}

// Emit a `meta` event when a monitored tab's title/favicon becomes available or
// changes. SPAs (like ACV) often have an empty title at record-start and update
// it via the History API without a full load, so we can't rely on the initial
// snapshot or tabs.onUpdated alone — we re-check on a short delay and on activity.
async function refreshTabMeta(tabId) {
  const rec = monitored.get(tabId);
  if (!rec) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab) return;
  const title = tab.title || '';
  const favIconUrl = tab.favIconUrl || '';
  if ((title && title !== rec.lastTitle) || (favIconUrl && favIconUrl !== rec.lastFav)) {
    rec.lastTitle = title; rec.lastFav = favIconUrl;
    emitMonitor(tabId, { kind: 'meta', title, favIconUrl, url: tab.url });
  }
}

async function screenshotMonitored(tabId) {
  const rec = monitored.get(tabId);
  if (!rec) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab || !tab.active) return; // captureVisibleTab only sees the visible tab
  // Keep the tab's title/favicon fresh (cheap; uses the tab we already fetched).
  const title = tab.title || '', favIconUrl = tab.favIconUrl || '';
  if ((title && title !== rec.lastTitle) || (favIconUrl && favIconUrl !== rec.lastFav)) {
    rec.lastTitle = title; rec.lastFav = favIconUrl;
    emitMonitor(tabId, { kind: 'meta', title, favIconUrl, url: tab.url });
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    if (dataUrl === rec.lastShot) return; // dedup: identical frame → skip (idle pages)
    rec.lastShot = dataUrl;
    emitMonitor(tabId, { kind: 'screenshot', dataUrl, url: tab.url });
    animateIconTick(); // flip the recording arrows on each captured frame
  } catch (e) { /* not focused / rate-limited */ }
}

// Debounced, per-tab screenshot triggered by user activity (click / scroll-stop
// / tab-visible). Replaces the old blind 4s interval so an idle tab produces no
// frames and each real interaction produces exactly one settled frame.
function scheduleActivityShot(tabId) {
  const rec = monitored.get(tabId);
  if (!rec) return;
  if (rec.shotTimer) clearTimeout(rec.shotTimer);
  rec.shotTimer = setTimeout(() => {
    rec.shotTimer = null;
    screenshotMonitored(tabId).catch(() => {});
  }, 500); // let the click/scroll settle before capturing
}

async function monitorStart(tabId) {
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'tabId (number) required.');
  const existing = monitored.get(tabId);
  if (existing) return { tabId, sessionKey: existing.sessionKey, already: true };
  const startedAt = Date.now();
  const sessionKey = `tab${tabId}-${startedAt}`;
  const rec = { sessionKey, startedAt, eventCount: 0, timer: null };
  monitored.set(tabId, rec);
  await injectCapture(tabId);
  let tab0 = null;
  try { tab0 = await chrome.tabs.get(tabId); } catch {}
  const startTitle = (tab0 && tab0.title) || '';
  const startFav = (tab0 && tab0.favIconUrl) || '';
  rec.lastTitle = startTitle; rec.lastFav = startFav;
  emitMonitor(tabId, {
    kind: 'session', event: 'start',
    url: (tab0 && tab0.url) || '',
    title: startTitle,
    favIconUrl: startFav,
    // storage root is chosen bridge-side (Research module default) now.
  });
  // SPAs may not have a title/favicon yet at start — re-check a few times so the
  // bridge can name the tab like the browser does.
  for (const delay of [700, 2000, 4500]) setTimeout(() => refreshTabMeta(tabId).catch(() => {}), delay);
  screenshotMonitored(tabId).catch(() => {}); // one initial frame; the rest are activity-driven
  updateIcon(); // refresh the recording-count badge + color
  // The bridge writes to <os.tmpdir()>/ai-browser-bridge/<sessionKey>/.
  return { tabId, sessionKey };
}

async function monitorStop(tabId) {
  const rec = monitored.get(tabId);
  if (!rec) return { tabId, stopped: false };
  emitMonitor(tabId, { kind: 'session', event: 'stop', eventCount: rec.eventCount });
  if (rec.shotTimer) clearTimeout(rec.shotTimer);
  monitored.delete(tabId);
  updateIcon(); // back to blue (connected, idle) + clear the badge
  return { tabId, stopped: true, sessionKey: rec.sessionKey };
}

function monitorList() {
  return Array.from(monitored.entries()).map(([tabId, r]) => ({
    tabId, sessionKey: r.sessionKey, startedAt: r.startedAt, eventCount: r.eventCount,
  }));
}

// Re-inject on navigation (full loads wipe injected scripts) + log navigations.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!monitored.has(tabId)) return;
  if (info.status === 'complete') {
    injectCapture(tabId);
    emitMonitor(tabId, { kind: 'navigation', url: tab && tab.url, title: tab && tab.title, favIconUrl: tab && tab.favIconUrl });
    screenshotMonitored(tabId).catch(() => {}); // capture once the page finished loading
  } else if (info.url) {
    emitMonitor(tabId, { kind: 'navigation', url: info.url });
  }
  // Title/favicon can arrive after load — forward so the bridge can name the tab.
  if (info.title || info.favIconUrl) {
    emitMonitor(tabId, { kind: 'meta', title: tab && tab.title, favIconUrl: tab && tab.favIconUrl, url: tab && tab.url });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { monitorStop(tabId).catch(() => {}); });

// Only allow http(s) navigation targets; block file:, chrome:, javascript:, etc.
function assertHttpLikeUrl(url) {
  if (typeof url !== 'string') {
    throw new CmdError('BAD_REQUEST', 'params.url (string) is required.');
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new CmdError('BAD_REQUEST', `Invalid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CmdError('FORBIDDEN', `Only http/https URLs are allowed (got ${u.protocol}).`);
  }
}

// ---------------------------------------------------------------------------
// Popup control-message handler
// ---------------------------------------------------------------------------
async function handlePopup(msg) {
  switch (msg.action) {
    case 'getState': {
      await ensureOffscreen();
      const bridgeUrl = await getLocal(K_BRIDGE_URL, DEFAULT_BRIDGE_URL);
      const ident = await ensureBrowserIdentity();
      return {
        running: true,
        version: VERSION,
        locked: !(await getPairKey()), // "locked" = not linked yet
        wsConnected,
        bridgeUrl,
        monitored: monitorList(),
        paired: !!(await getPairKey()),
        browserId: ident.id,
        browserName: ident.name,
      };
    }

    case 'pair': {
      await ensureOffscreen();
      return await startPairing();
    }

    case 'unpair': {
      await clearPairing();
      return { ok: true };
    }

    case 'monitorStart': {
      try { return { ok: true, ...(await monitorStart(msg.tabId)) }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    case 'monitorStop': {
      return { ok: true, ...(await monitorStop(msg.tabId)) };
    }
    case 'monitorList': {
      return { ok: true, list: monitorList() };
    }

    case 'setBridgeUrl': {
      const url = String(msg.url || '').trim();
      if (!/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
        return { ok: false, error: 'Bridge URL must be ws(s)://127.0.0.1[:port]/path' };
      }
      await setLocal({ [K_BRIDGE_URL]: url });
      await sendToOffscreen({ type: 'CONFIG', bridgeUrl: url }).catch(() => {});
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown popup action: ${msg.action}` };
  }
}
