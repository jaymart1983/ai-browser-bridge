// background.js — MV3 service worker (ES module).
//
// RESPONSIBILITIES
//   * Owns ALL authentication + authorization state: the PBKDF2 password record
//     lives in chrome.storage.local; the session token + unlock rate-limiting
//     live in memory (token) and storage (rate-limit counters).
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

import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  generatePassword,
} from './crypto.js';

const VERSION = '0.1.0';
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787/agent';

// Session token sliding-expiry window: 15 minutes of inactivity.
// Auth model: the auto-generated access code (K_PASSWORD_RECORD) IS the bearer
// credential. Callers send it as `token` (or `password`) on EVERY request; it
// stays valid until it rotates (K_ROTATE_DAYS, default 7) or the user resets it.
// There is deliberately no session/unlock window — nothing to expire mid-use.

// Keepalive alarm period. The spec asks for 25s; Chrome may clamp very short
// alarm periods (historically to a 30s floor for unpacked extensions), which is
// fine — the offscreen document runs its own faster reconnect loop, and this
// alarm is only a coarse "make sure everything is still alive" heartbeat.
const KEEPALIVE_ALARM = 'bridge-keepalive';
const KEEPALIVE_PERIOD_MIN = 25 / 60;

// Storage keys.
const K_PASSWORD_RECORD = 'passwordRecord'; // {salt, iterations, hashB64}
const K_RATE_LIMIT = 'unlockRateLimit'; // {failCount, lockoutUntil, lastAttempt}
// Tab policy (allow/storage) used to live here; it is now bridge-owned (rule
// engine). The extension keeps only pairing + the browser primitives.
const K_PAIR_KEY = 'pairKeyHex'; // ECDH-derived HMAC key (hex) shared with the bridge
const K_BRIDGE_URL = 'bridgeUrl'; // string
// The AUTO-GENERATED default password is kept in plaintext in local storage so
// the popup can show + copy it any time (the user's explicit request — most of
// the time they just copy it). This is a deliberate convenience tradeoff: the
// threat model is "local machine trust" (anyone with your browser profile
// already has your logged-in sessions). A password YOU set instead is stored
// ONLY as a PBKDF2 hash and is never displayed.
const K_DEFAULT_PLAINTEXT = 'defaultPasswordPlain'; // string | absent (custom pw set)
const K_ROTATE_DAYS = 'rotateDays'; // number of days; 0 = never auto-rotate
const K_LAST_ROTATED = 'lastRotatedAt'; // ms timestamp
const DEFAULT_ROTATE_DAYS = 7;

// Capabilities advertised by `status`.
const CAPABILITIES = [
  'status',
  'unlock',
  'lock',
  'tabs.list',
  'tab.navigate',
  'tab.create',
  'tab.activate',
  'tab.close',
  'page.read',
  'page.eval',
  'page.screenshot',
  'monitor.start',
  'monitor.stop',
  'monitor.list',
];

// ---------------------------------------------------------------------------
// Live connection state (in-memory; not persisted).
// ---------------------------------------------------------------------------
let wsConnected = false;

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
function drawTransferIcon(size, color, phase = 0) {
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
    const img = drawTransferIcon(size, color, iconPhase);
    if (img) imageData[size] = img;
  }
  if (Object.keys(imageData).length && chrome.action && chrome.action.setIcon) {
    chrome.action.setIcon({ imageData }).catch(() => {});
    const n = monitored.size;
    chrome.action
      .setTitle({
        title: `AI Browser Bridge — ${wsConnected ? 'bridge connected' : 'bridge OFF'}` +
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

// Plaintext of the freshly generated default password is held ONLY in memory
// and mirrored to chrome.storage.session (RAM-only, never written to disk) so
// the popup can display it once. It is deleted as soon as the user acknowledges
// it or changes the password. We never write it to chrome.storage.local.

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
// First-install setup: generate the default password, store only its hash.
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureDefaults();
    if (details.reason === 'install') {
      const existing = await getLocal(K_PASSWORD_RECORD, null);
      if (!existing) {
        const pw = generatePassword(24); // ~155 bits of entropy
        const record = await hashPassword(pw);
        // Store hash (for verification) + plaintext (for the always-on popup
        // display/copy). Plaintext is removed the moment a custom pw is set.
        await setLocal({
          [K_PASSWORD_RECORD]: record,
          [K_DEFAULT_PLAINTEXT]: pw,
          [K_LAST_ROTATED]: Date.now(),
          [K_ROTATE_DAYS]: DEFAULT_ROTATE_DAYS,
        });
      }
    }
  } catch (e) {
    console.error('[bridge] onInstalled setup failed', e);
  }
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
}

async function bootstrap() {
  updateIcon(); // reflect current (likely disconnected) state immediately
  await ensureDefaults();
  await maybeRotate();
  await ensureOffscreen();
  await ensureKeepaliveAlarm();
}

// Auto-rotate the AUTO-GENERATED password after `rotateDays`. Only rotates while
// the auto-gen password is in use (never a custom one). After rotation, re-copy
// it from the popup. Runs on startup + on the keepalive alarm.
async function maybeRotate() {
  const days = await getLocal(K_ROTATE_DAYS, DEFAULT_ROTATE_DAYS);
  if (!days || days <= 0) return;
  const plain = await getLocal(K_DEFAULT_PLAINTEXT, null);
  if (!plain) return; // custom password set — leave it alone
  const last = await getLocal(K_LAST_ROTATED, 0);
  if (Date.now() - last < days * 86400000) return;
  const pw = generatePassword(24);
  const record = await hashPassword(pw);
  await setLocal({ [K_PASSWORD_RECORD]: record, [K_DEFAULT_PLAINTEXT]: pw, [K_LAST_ROTATED]: Date.now() });
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
    await maybeRotate();
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
    updateIcon();
    return; // no response needed
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
// Auth helpers
// ---------------------------------------------------------------------------
// "Locked" now means simply "no access code configured yet" — normally false,
// since a code is auto-generated on install. There is no session to lock/unlock.
async function hasAccessCode() {
  return (await getLocal(K_PASSWORD_RECORD, null)) !== null;
}

// ---------------------------------------------------------------------------
// Unlock rate-limiting / lockout
// ---------------------------------------------------------------------------
function lockoutForFailCount(failCount) {
  // Escalating lockouts. Early failures get a short exponential backoff; once
  // the user crosses 5 and then 10 failures the lockout jumps sharply.
  if (failCount >= 10) return 15 * 60 * 1000; // 15 min
  if (failCount >= 5) return 60 * 1000; // 1 min
  return Math.min(Math.pow(2, failCount - 1) * 1000, 30 * 1000); // 1s,2s,4s,8s...
}

async function getRateLimit() {
  return await getLocal(K_RATE_LIMIT, { failCount: 0, lockoutUntil: 0, lastAttempt: 0 });
}

// ---------------------------------------------------------------------------
// Command router (handles messages from the bridge WS)
// ---------------------------------------------------------------------------
async function handleCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.id === 'undefined') {
    return { id: (cmd && cmd.id) ?? null, error: { code: 'BAD_REQUEST', message: 'Missing id' } };
  }
  const { id, method, params = {}, token } = cmd;

  try {
    switch (method) {
      case 'status':
        return { id, result: await doStatus() };

      // Bearer model: `unlock`/`lock` are retained only for backward compat.
      // `unlock` just verifies the code (no session is minted); `lock` is a
      // no-op since there is no session to end.
      case 'unlock':
        return { id, result: await doUnlock(params) };

      case 'lock':
        await requireAuth(cmd);
        return { id, result: { ok: true, note: 'Bearer model — no session to lock.' } };

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

// Kick off pairing: generate an ECDH keypair, send our public key to the bridge.
async function startPairing() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  pairEphemeral = kp;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  sendToOffscreen({ type: 'WS_SEND', frame: { type: 'pair_init', pub: bufToHex(raw) } }).catch(() => {});
  return { ok: true };
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

// Authorize a command. Preferred path: a valid bridge signature (paired). Until
// the bridge is paired, fall back to the legacy bearer access code so nothing
// breaks mid-migration.
async function requireAuth(cmd) {
  if (await getPairKey()) {
    if (await verifyFrameMac(cmd)) return;
    throw new CmdError('UNAUTHORIZED', 'Missing or invalid bridge signature.');
  }
  const code =
    cmd && typeof cmd.token === 'string' ? cmd.token
      : cmd && typeof cmd.password === 'string' ? cmd.password : null;
  if (code === null) throw new CmdError('UNAUTHORIZED', 'Not paired; provide the access code (as `token`).');
  await checkPassword(code); // throws on wrong/locked-out
}

// Verify a password against the stored record with lockout/rate-limiting.
// Returns true on success; throws CmdError('RATE_LIMITED'|'UNAUTHORIZED'|...).
async function checkPassword(password) {
  const rl = await getRateLimit();
  const now = Date.now();
  if (rl.lockoutUntil && now < rl.lockoutUntil) {
    throw new CmdError('RATE_LIMITED', `Too many failed attempts. Retry in ${Math.ceil((rl.lockoutUntil - now) / 1000)}s.`);
  }
  const record = await getLocal(K_PASSWORD_RECORD, null);
  if (!record) throw new CmdError('NOT_INITIALIZED', 'No password configured. Open the extension popup.');
  const ok = await verifyPassword(password, record);
  if (!ok) {
    const failCount = (rl.failCount || 0) + 1;
    const lockoutUntil = now + lockoutForFailCount(failCount);
    await setLocal({ [K_RATE_LIMIT]: { failCount, lockoutUntil, lastAttempt: now } });
    throw new CmdError('UNAUTHORIZED', `Incorrect password (attempt ${failCount}). Retry in ${Math.ceil((lockoutUntil - now) / 1000)}s.`);
  }
  await setLocal({ [K_RATE_LIMIT]: { failCount: 0, lockoutUntil: 0, lastAttempt: now } });
  return true;
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
    locked: !(await hasAccessCode()),
    tabCount,
    wsConnected,
    capabilities: CAPABILITIES,
  };
}

// `unlock` is retained for backward compatibility only. In the bearer model it
// simply VERIFIES the access code (rate-limited) and echoes guidance — it does
// NOT mint a session token. Callers should just send the code on each request.
async function doUnlock(params) {
  const code = params && (params.password ?? params.token);
  if (typeof code !== 'string') {
    throw new CmdError('BAD_REQUEST', 'params.password (or token) is required.');
  }
  await checkPassword(code); // throws on wrong/locked-out
  return {
    ok: true,
    bearer: true,
    note: 'Send this code as `token` on every request; valid until it rotates.',
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
      // The auto-generated default password — legacy bootstrap before pairing.
      const defaultPassword = await getLocal(K_DEFAULT_PLAINTEXT, null);
      const rl = await getRateLimit();
      return {
        running: true,
        version: VERSION,
        locked: !(await hasAccessCode()),
        wsConnected,
        bridgeUrl,
        defaultPassword,
        isCustomPassword: defaultPassword === null,
        monitored: monitorList(),
        rateLimit: { failCount: rl.failCount || 0, lockoutUntil: rl.lockoutUntil || 0 },
        paired: !!(await getPairKey()),
      };
    }

    case 'setRotateDays': {
      const d = Number(msg.days);
      await setLocal({ [K_ROTATE_DAYS]: Number.isFinite(d) && d >= 0 ? d : 0 });
      return { ok: true };
    }

    case 'pair': {
      await ensureOffscreen();
      return await startPairing();
    }

    case 'unpair': {
      await clearPairing();
      return { ok: true };
    }

    case 'lock': {
      // Bearer model: no session to end. Kept as a harmless no-op.
      return { ok: true, note: 'Bearer model — no session to lock.' };
    }

    case 'unlock': {
      try {
        const result = await doUnlock({ password: msg.password });
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, code: e.code || 'ERROR', error: e.message };
      }
    }

    case 'regenerateDefault': {
      // Re-roll a fresh auto-generated access code (stays visible/copyable).
      // The old code stops working immediately — checkPassword verifies against
      // the new record — which is exactly the "reset" behavior we want.
      const pw = generatePassword(24);
      const record = await hashPassword(pw);
      await setLocal({ [K_PASSWORD_RECORD]: record, [K_DEFAULT_PLAINTEXT]: pw, [K_LAST_ROTATED]: Date.now() });
      return { ok: true, password: pw };
    }

    case 'changePassword': {
      const { newPassword } = msg;
      // No current-password check needed: the popup is only reachable by the
      // person at the machine, and the default is shown right there anyway.
      const policy = validatePasswordPolicy(newPassword || '');
      if (!policy.ok) return { ok: false, error: policy.reasons.join(' ') };
      const newRecord = await hashPassword(newPassword);
      await setLocal({ [K_PASSWORD_RECORD]: newRecord });
      // Custom password: stop displaying a plaintext (we only keep the hash).
      await chrome.storage.local.remove(K_DEFAULT_PLAINTEXT);
      // Old code stops working automatically (verified against the new record).
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
