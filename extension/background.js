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

// Single source of truth: the manifest version (bumped at release). Never hardcode
// a version here — it drifts from manifest.json and misreports in the popup.
const VERSION = chrome.runtime.getManifest().version;
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
const K_PAIR_EPHEMERAL = 'pairEphemeralJwk'; // in-flight ECDH private key, so the handshake survives SW suspension
const K_BRIDGE_URL = 'bridgeUrl'; // string
const K_BROWSER_ID = 'browserId'; // stable per-install id so the bridge can tell browsers apart
const K_BROWSER_NAME = 'browserName'; // friendly label (Chrome / Brave / Edge / …)
// The raw evidence behind that label, surfaced in the control panel so a user can tell
// two look-alike Chromium browsers apart (and see WHY one was auto-named as it was).
const K_BROWSER_UA = 'browserUa';
const K_BROWSER_BRANDS = 'browserBrands';

// Best-effort browser name for the linked-browsers list in the bridge. Specific
// Chromium forks are matched before the generic "Chrome" fallback. NOTE: some forks
// (Arc, Island, plain Chromium builds) don't always alter the UA and can still fall
// through to "Chrome"/"Chromium" — the user can relabel a linked browser in the
// bridge dashboard to tell them apart.
function detectBrowserName() {
  try {
    const ua = (self.navigator && navigator.userAgent) || '';
    // Chromium forks (Island, Arc, enterprise builds) often keep a VANILLA Chrome user
    // agent on purpose — sites break otherwise — so the UA can't tell them apart. The
    // UA-CH brand list is where a fork actually names itself, so check it FIRST and
    // ignore the entries every Chromium reports (plus the deliberate GREASE junk).
    const brands = (self.navigator && navigator.userAgentData && navigator.userAgentData.brands) || [];
    const generic = /^(chromium|google chrome|microsoft edge|not[.\/ ]?a[.\/ ]?brand|not-a\.brand|not_a brand)$/i;
    for (const b of brands) {
      const n = String((b && b.brand) || '').trim();
      if (n && !generic.test(n) && !/^not/i.test(n)) return n;
    }
    if (self.navigator && navigator.brave) return 'Brave';
    if (/\bEdg(A|iOS)?\//.test(ua)) return 'Edge';
    if (/\bOPR\/|\bOpera\//.test(ua)) return 'Opera';
    if (/\bVivaldi/.test(ua)) return 'Vivaldi';
    if (/\bYaBrowser\//.test(ua)) return 'Yandex';
    // Island appends a token like "island_browser_<org>" rather than "Island/…", so
    // match the family, not a version-style slash.
    if (/\bisland[_\/ -]/i.test(ua)) return 'Island';
    if (/\bDuckDuckGo\//i.test(ua)) return 'DuckDuckGo';
    if (/\bArc\//.test(ua)) return 'Arc';
    if (/\bHeadlessChrome\//.test(ua)) return 'Chrome (headless)';
    if (/\bChromium\//.test(ua)) return 'Chromium';
    if (/\bChrome\//.test(ua)) return 'Chrome';
    return 'Browser';
  } catch { return 'Browser'; }
}
// Ensure this install has a stable id + name (used to identify it to the bridge).
async function ensureBrowserIdentity() {
  const cur = await chrome.storage.local.get([K_BROWSER_ID, K_BROWSER_NAME, K_BROWSER_UA, K_BROWSER_BRANDS]);
  const patch = {};
  if (typeof cur[K_BROWSER_ID] !== 'string' || !cur[K_BROWSER_ID]) {
    const rnd = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36));
    patch[K_BROWSER_ID] = 'br_' + rnd.slice(0, 16);
  }
  const storedName = cur[K_BROWSER_NAME];
  if (typeof storedName !== 'string' || !storedName) patch[K_BROWSER_NAME] = detectBrowserName();
  else if (/^(chrome|chromium|browser)$/i.test(storedName)) {
    // Upgrade a generic name detected by an older build: this install may be a fork
    // that only identifies itself through the UA-CH brand list. Safe to re-detect —
    // this is the browser's own guess, and the bridge ignores it once the user has
    // renamed the browser there.
    const better = detectBrowserName();
    if (better && !/^(chrome|chromium|browser)$/i.test(better)) patch[K_BROWSER_NAME] = better;
  }
  // Refresh the raw signals every time — a browser update changes them, and they are
  // only ever descriptive (the same values every website already receives).
  try {
    patch[K_BROWSER_UA] = String((self.navigator && navigator.userAgent) || '').slice(0, 400);
    const br = (self.navigator && navigator.userAgentData && navigator.userAgentData.brands) || [];
    patch[K_BROWSER_BRANDS] = br.map((b) => ({ brand: String(b.brand || '').slice(0, 60), version: String(b.version || '').slice(0, 20) })).slice(0, 12);
  } catch { /* keep whatever was stored */ }
  if (Object.keys(patch).length) await setLocal(patch);
  return {
    id: patch[K_BROWSER_ID] || cur[K_BROWSER_ID],
    name: patch[K_BROWSER_NAME] || cur[K_BROWSER_NAME],
    ua: patch[K_BROWSER_UA] || cur[K_BROWSER_UA] || '',
    brands: patch[K_BROWSER_BRANDS] || cur[K_BROWSER_BRANDS] || [],
  };
}

// Capabilities advertised by `status`.
const CAPABILITIES = [
  'status',
  'tabs.list',
  'tab.focused',
  'tab.navigate',
  'tab.create',
  'tab.activate',
  'tab.close',
  'page.read',
  'page.eval',
  'page.fetch',
  'page.exec',
  'page.screenshot',
  'page.click',
  'page.fill',
  'page.scroll',
  'monitor.start',
  'monitor.stop',
  'monitor.list',
  'overlay.set',
  'overlay.clear',
  'overlay.list',
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
        title: `Browser Bridge — ${wsConnected ? 'bridge connected' : 'bridge OFF'}` +
          (pendingAuth ? ` · ${pendingAuth} agent${pendingAuth === 1 ? '' : 's'} awaiting approval` : '') +
          (n ? ` · recording ${n} tab${n === 1 ? '' : 's'}` : ''),
      })
      .catch(() => {});
  }
  // The recording indicator is now PER-TAB (see setTabRecordingBadge): a red ● shows
  // on the icon only for the specific tab being recorded. Keep the GLOBAL badge empty
  // so tabs that aren't recording stay clean, and set the shared badge colors here.
  if (chrome.action && chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#e5484d' }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
  }
}

// Paint a red ● on the toolbar icon FOR one specific tab while it's being recorded.
// Chrome shows the per-tab badge only when that tab is active, so the icon tells you
// at a glance whether the tab you're looking at is recording. Clearing reverts it to
// the empty global badge.
function setTabRecordingBadge(tabId, on) {
  if (!(chrome.action && chrome.action.setBadgeText) || typeof tabId !== 'number') return;
  chrome.action.setBadgeText({ tabId, text: on ? '●' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#e5484d' }).catch(() => {});
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
  // Push the current bridge URL to the new document (embedded appends its token).
  const bridgeUrl = await effectiveBridgeUrl();
  await sendToOffscreen({ type: 'CONFIG', bridgeUrl, version: VERSION }).catch(() => {});
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
    if (wsConnected) { sendIdentity(); } // identify this browser to the bridge (linking is a manual "Link" click)
    updateIcon();
    return; // no response needed
  }

  // Pending-auth count pushed from the bridge → top-left icon badge.
  if (msg.type === 'PENDING') {
    pendingAuth = Math.max(0, msg.count | 0);
    updateIcon();
    return;
  }

  // Bridge self-updated the extension source on disk → reload to run the new code.
  // For an unpacked extension, chrome.runtime.reload() re-reads the files from disk.
  if (msg.type === 'RELOAD_EXTENSION') {
    try { chrome.runtime.reload(); } catch {}
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

  // Overlay scan report: which of OUR annotation keys matched / are on screen. Only
  // our own keys, never page content. Throttled — infinite scroll fires often.
  if (msg.type === 'OVERLAY_SEEN') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === 'number') {
      const now = Date.now();
      if (now - (overlaySeenAt.get(tabId) || 0) > 1000) {
        overlaySeenAt.set(tabId, now);
        sessGet(OVERLAY_SEEN_KEY).then((s) => {
          s[String(tabId)] = {
            matched: Array.isArray(msg.matched) ? msg.matched.slice(0, 500) : [],
            visible: Array.isArray(msg.visible) ? msg.visible.slice(0, 500) : [],
            ts: now,
          };
          return sessSet(OVERLAY_SEEN_KEY, s);
        }).catch(() => {});
      }
    }
    return;
  }

  // The user marked an annotated item in-page (Pass / Watch / Note). We do NOT store
  // it. It is sent to the bridge as an `overlay_mark` frame — HMAC-signed with the
  // pairing key so the bridge can prove a human's browser produced it (unsigned local
  // code can't fabricate user decisions; same model as the OAuth approval signature).
  // Works WITHOUT the tab being recorded; when the tab IS being recorded we also file
  // it into the recording so the decision is part of that artifact.
  if (msg.type === 'OVERLAY_ACTION') {
    const tabId = sender && sender.tab && sender.tab.id;
    const mark = {
      key: String(msg.key || '').slice(0, 120),
      action: String(msg.action || '').slice(0, 24),
      reason: String(msg.reason || '').slice(0, 400),
      url: (sender.tab && sender.tab.url) || '',
    };
    (async () => {
      if (typeof tabId !== 'number') return { ok: false, delivered: false, recorded: false };
      const recorded = monitored.has(tabId);
      if (recorded) emitMonitor(tabId, { kind: 'annotation', ...mark });
      const ts = Date.now();
      let mac = null;
      try {
        const keyHex = await getPairKey();
        if (keyHex) {
          const k = await crypto.subtle.importKey('raw', hexToBuf(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          // Canonical string MUST match bridge/pairing.mjs verifyMark.
          const canon = JSON.stringify([ts, tabId, mark.key, mark.action, mark.reason, mark.url]);
          mac = bufToHex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(canon)));
        }
      } catch { /* not linked / crypto unavailable */ }
      // Honest delivery status: only claim delivery when the socket is up AND we
      // could sign (the bridge drops unsigned marks).
      const delivered = !!(wsConnected && mac);
      if (delivered) sendToOffscreen({ type: 'WS_SEND', frame: { type: 'overlay_mark', tabId, ts, ...mark, mac } }).catch(() => {});
      return { ok: true, delivered, recorded };
    })().then(sendResponse).catch(() => sendResponse({ ok: false, delivered: false, recorded: false }));
    return true; // async response
  }

  // A decision relayed from the bridge's own control panel (see bridge-page.js). The
  // page cannot sign — the pairing key never leaves this service worker — so it asks
  // us to. The security property is preserved by checking sender.origin, which the
  // page cannot forge: only the CONFIGURED bridge origin may use this relay, so
  // another local server can't borrow it to approve itself.
  if (msg.type === 'PAGE_DECISION') {
    (async () => {
      try {
        const bridgeHttpOrigin = new URL((await effectiveBridgeUrl()).replace(/^ws/, 'http')).origin;
        if (!sender || sender.origin !== bridgeHttpOrigin) {
          return sendResponse({ ok: false, error: 'Only the bridge control panel may approve from a page.' });
        }
        const fn = msg.kind === 'module' ? submitModuleDecision : submitOauthDecision;
        sendResponse(await fn(String(msg.reqId || ''), !!msg.approve));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // async
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

      case 'tab.focused':
        await requireAuth(cmd);
        return { id, result: await doTabFocused() };

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

      case 'page.click':
        await requireAuth(cmd);
        return { id, result: await doPageClick(params) };

      case 'page.fill':
        await requireAuth(cmd);
        return { id, result: await doPageFill(params) };

      case 'page.scroll':
        await requireAuth(cmd);
        return { id, result: await doPageScroll(params) };

      case 'monitor.start':
        await requireAuth(cmd);
        return { id, result: await monitorStart(params.tabId) };

      case 'monitor.stop':
        await requireAuth(cmd);
        return { id, result: await monitorStop(params.tabId) };

      case 'monitor.list':
        await requireAuth(cmd);
        return { id, result: monitorList() };

      case 'overlay.set':
        await requireAuth(cmd);
        return { id, result: await overlaySet(params) };

      case 'overlay.clear':
        await requireAuth(cmd);
        return { id, result: await overlayClear(params) };

      case 'overlay.list':
        await requireAuth(cmd);
        return { id, result: await overlayList(params) };

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
let pairError = ''; // last pairing failure reason, surfaced to the popup

// EMBEDDED MODE: a host application that bundles this extension writes
// embedded.json into the extension directory: { "token": "...", "bridgeUrl"? }.
// When present, the WS upgrade carries ?token=..., the frame-signing key is
// SHA-256(token) on both sides (matching bridge/pairing.mjs), and interactive
// pairing is disabled — the host owns the trust relationship.
let embeddedConf; // undefined = not probed yet, null = absent, object = active
async function getEmbedded() {
  if (embeddedConf !== undefined) return embeddedConf;
  embeddedConf = null;
  try {
    const r = await fetch(chrome.runtime.getURL('embedded.json'));
    if (r.ok) {
      const d = await r.json();
      if (d && typeof d.token === 'string' && d.token.length >= 16) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(d.token));
        embeddedConf = {
          token: d.token,
          bridgeUrl: typeof d.bridgeUrl === 'string' && d.bridgeUrl ? d.bridgeUrl : DEFAULT_BRIDGE_URL,
          keyHex: bufToHex(digest),
        };
      }
    }
  } catch { /* no embedded.json → standalone */ }
  return embeddedConf;
}
// The URL the offscreen document should connect to (embedded appends the token).
async function effectiveBridgeUrl() {
  const emb = await getEmbedded();
  if (emb) return emb.bridgeUrl + (emb.bridgeUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(emb.token);
  return getLocal(K_BRIDGE_URL, DEFAULT_BRIDGE_URL);
}

async function getPairKey() {
  const emb = await getEmbedded();
  if (emb) return emb.keyHex;
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

// Approve/deny an OAuth consent request. Signed HERE with the pairing key (which
// never leaves the service worker) so the bridge knows a HUMAN in this paired
// browser approved it — an unsigned local process cannot. The popup routes its
// Approve/Deny clicks through here.
async function submitSignedDecision(path, reqId, approve) {
  const keyHex = await getPairKey();
  if (!keyHex) return { ok: false, error: 'This browser is not linked to the bridge.' };
  const key = await crypto.subtle.importKey('raw', hexToBuf(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${reqId}\n${approve ? 1 : 0}`));
  const mac = bufToHex(sig);
  const base = (await getLocal(K_BRIDGE_URL, DEFAULT_BRIDGE_URL)).replace(/^ws/, 'http').replace(/\/agent.*$/, '');
  try {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqId, approve: approve ? 1 : 0, mac }) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}
const submitOauthDecision = (reqId, approve) => submitSignedDecision('/oauth/decision', reqId, approve);
// Approve/deny a pending MODULE INSTALL (arbitrary JS staged via the web UI) —
// same human-signed gate as OAuth consent, since installing a module is code
// execution inside the bridge.
const submitModuleDecision = (reqId, approve) => submitSignedDecision('/modules/decision', reqId, approve);

// Kick off pairing: generate an ECDH keypair, send our public key to the bridge.
// Only ever runs from a user-initiated "Link" click — there is no auto-pair path.
async function startPairing() {
  if (await getEmbedded()) return { ok: false, error: 'Pairing is managed by the host application.' };
  pairError = '';
  // Extractable so we can stash the private key: MV3 service workers get suspended,
  // and if that happens between pair_init and pair_ack an in-memory key would be
  // lost and the handshake would silently fail (seen on aggressive enterprise
  // browsers). We persist it briefly and delete it as soon as pairing finishes.
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  pairEphemeral = kp;
  try { await setLocal({ [K_PAIR_EPHEMERAL]: await crypto.subtle.exportKey('jwk', kp.privateKey) }); } catch {}
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const { id, name } = await ensureBrowserIdentity();
  const frame = { type: 'pair_init', pub: bufToHex(raw), browserId: id, browserName: name };
  sendToOffscreen({ type: 'WS_SEND', frame }).catch(() => {});
  return { ok: true };
}

// Announce WHICH browser we are to the bridge (from the SW, where the id is
// reliably available), so the bridge maps this socket / migrates a legacy pairing.
// Sent on every (re)connect.
async function sendIdentity() {
  try {
    const { id, name, ua, brands } = await ensureBrowserIdentity();
    await sendToOffscreen({ type: 'WS_SEND', frame: { type: 'hello', role: 'extension', version: VERSION, browserId: id, browserName: name, ua, brands } });
  } catch { /* offscreen not ready; next connect will retry */ }
}

// Finish pairing: derive the shared key from the bridge's public key.
async function finishPairing(bridgePubHex) {
  let priv = pairEphemeral && pairEphemeral.privateKey;
  if (!priv) {
    // SW was suspended mid-handshake — recover the ephemeral we stashed.
    try { const jwk = await getLocal(K_PAIR_EPHEMERAL, null); if (jwk) priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); } catch {}
  }
  if (!priv) { pairError = 'Lost the handshake (service worker restarted). Click Link again.'; updateIcon(); return; }
  try {
    const bridgePub = await crypto.subtle.importKey('raw', hexToBuf(bridgePubHex), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: bridgePub }, priv, 256);
    const keyBuf = await crypto.subtle.digest('SHA-256', bits);
    pairKeyHex = bufToHex(keyBuf);
    await setLocal({ [K_PAIR_KEY]: pairKeyHex });
    pairError = '';
  } catch (e) {
    pairError = 'Pairing failed: ' + ((e && e.message) || e);
  } finally {
    pairEphemeral = null;
    try { await chrome.storage.local.remove(K_PAIR_EPHEMERAL); } catch {}
    updateIcon();
  }
}

async function clearPairing() { pairKeyHex = null; pairEphemeral = null; pairError = ''; await chrome.storage.local.remove([K_PAIR_KEY, K_PAIR_EPHEMERAL]); }

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
// `active` is per WINDOW — with several windows open, several tabs are "active" at
// once, so it cannot answer "which tab is the user actually looking at". `focused`
// is the active tab of the focused window: at most one, and the one that matters for
// annotate/screenshot/read-what-I'm-seeing.
async function focusedWindowId() {
  try { const w = await chrome.windows.getLastFocused(); return w && w.id; } catch { return undefined; }
}

async function doTabsList() {
  const [tabs, focusedWin] = await Promise.all([chrome.tabs.query({}), focusedWindowId()]);
  return tabs.map((t) => ({
    tabId: t.id,
    url: t.url || t.pendingUrl || '',
    title: t.title || '',
    favIconUrl: t.favIconUrl || '',
    active: !!t.active,
    windowId: t.windowId,
    focused: !!t.active && t.windowId === focusedWin,
  }));
}

async function doTabFocused() {
  let t = null;
  try { [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch { /* fall through */ }
  if (!t) return { tab: null };
  return {
    tab: {
      tabId: t.id,
      url: t.url || t.pendingUrl || '',
      title: t.title || '',
      favIconUrl: t.favIconUrl || '',
      active: !!t.active,
      windowId: t.windowId,
      focused: true,
    },
  };
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

// ---------------------------------------------------------------------------
// First-class user-action primitives: click / fill / scroll. Fixed injected
// functions (ISOLATED world, no eval) so they work on strict-CSP pages, firing
// the full event sequences frameworks listen for. These exist so agents don't
// have to hand-write page JS via page.eval for the three most common actions.
// ---------------------------------------------------------------------------

async function doPageClick(params) {
  const { tabId, selector, text } = params || {};
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  if (!selector && !text) throw new CmdError('BAD_REQUEST', 'Provide selector (CSS) or text (visible label).');
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, label) => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      let candidates = [];
      if (sel) {
        try { candidates = Array.from(document.querySelectorAll(sel)); }
        catch (e) { return { error: 'bad selector: ' + e.message }; }
      } else {
        // Match visible labels on clickable elements: exact match first, then the
        // shortest label containing the text (avoids grabbing a whole card).
        const want = String(label).trim().toLowerCase();
        const scored = [];
        for (const el of document.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"],summary,label,[onclick]')) {
          // innerText needs layout and can be empty in a never-rendered tab — fall
          // back to textContent so click-by-text works on background tabs too.
          const t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
          if (!t) continue;
          const lower = t.toLowerCase();
          if (lower === want) scored.push([0, t.length, el]);
          else if (lower.includes(want)) scored.push([1, t.length, el]);
        }
        scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        candidates = scored.map((s) => s[2]);
      }
      const matches = candidates.length;
      const el = candidates.find(visible) || candidates[0];
      if (!el) return { error: sel ? 'no element matches that selector' : 'no clickable element with that visible text' };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* non-scrollable */ }
      const opts = { bubbles: true, cancelable: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        try { el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts)); } catch (e) { /* keep going */ }
      }
      try { el.click(); } catch (e) { try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e2) { /* best effort */ } }
      return {
        clicked: true, matches,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').trim().slice(0, 120),
        href: el.href ? String(el.href).slice(0, 300) : undefined,
      };
    },
    args: [selector || null, text || null],
  });
  const out = res && res.result;
  if (!out) throw new CmdError('INTERNAL', 'No result from page.');
  if (out.error) throw new CmdError('NOT_FOUND', out.error);
  return { tabId, ...out };
}

async function doPageFill(params) {
  const { tabId, selector, value, enter } = params || {};
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  if (typeof selector !== 'string' || !selector) throw new CmdError('BAD_REQUEST', 'params.selector (CSS string) is required.');
  if (typeof value !== 'string') throw new CmdError('BAD_REQUEST', 'params.value (string) is required.');
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val, pressEnter) => {
      let el;
      try { el = document.querySelector(sel); } catch (e) { return { error: 'bad selector: ' + e.message }; }
      if (!el) return { error: 'no element matches that selector' };
      // Hard line, enforced here in the extension (not just agent policy): the
      // bridge never touches credential fields. The user signs in themselves.
      const itype = (el.type || '').toLowerCase();
      const ac = (el.getAttribute && el.getAttribute('autocomplete')) || '';
      if (itype === 'password' || /password|one-time-code/i.test(ac)) {
        return { error: 'REFUSED: password/credential fields are never filled by the bridge — ask the user to sign in themselves.' };
      }
      try { el.focus(); } catch (e) { /* continue unfocused */ }
      const fire = (t, Ev) => { try { el.dispatchEvent(new (Ev || Event)(t, { bubbles: true })); } catch (e) { /* best effort */ } };
      if (el.tagName === 'SELECT') {
        let hit = null;
        for (const o of el.options) { if (o.value === val || o.text.trim() === val) { hit = o; break; } }
        if (!hit) {
          const opts = Array.from(el.options).slice(0, 30).map((o) => o.text.trim()).join(' | ');
          return { error: 'no <option> with that value or label. Options: ' + opts };
        }
        el.value = hit.value;
        fire('input'); fire('change');
      } else if (el.isContentEditable) {
        el.textContent = val;
        fire('input', InputEvent);
      } else if ('value' in el) {
        // Native setter so frameworks (React/Vue) observe the change as real typing.
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, val); else el.value = val;
        fire('input', InputEvent); fire('change');
      } else {
        return { error: 'element is not an input, textarea, select, or contenteditable' };
      }
      let submitted = false;
      if (pressEnter) {
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        try { el.dispatchEvent(new KeyboardEvent('keydown', key)); el.dispatchEvent(new KeyboardEvent('keyup', key)); } catch (e) { /* best effort */ }
        // A synthetic Enter is untrusted and won't submit a form on its own.
        const form = el.form || (el.closest && el.closest('form'));
        if (form) { try { form.requestSubmit(); submitted = true; } catch (e) { try { form.submit(); submitted = true; } catch (e2) { /* no submit */ } } }
      }
      return { filled: true, tag: el.tagName.toLowerCase(), name: el.name || el.id || '', length: val.length, submitted };
    },
    args: [selector, value, !!enter],
  });
  const out = res && res.result;
  if (!out) throw new CmdError('INTERNAL', 'No result from page.');
  if (out.error) throw new CmdError(out.error.startsWith('REFUSED') ? 'FORBIDDEN' : 'NOT_FOUND', out.error);
  return { tabId, ...out };
}

async function doPageScroll(params) {
  const { tabId, to, pages, selector } = params || {};
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (t, p, sel) => {
      if (sel) {
        let el;
        try { el = document.querySelector(sel); } catch (e) { return { error: 'bad selector: ' + e.message }; }
        if (!el) return { error: 'no element matches that selector' };
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* non-scrollable */ }
      } else if (t === 'top') {
        window.scrollTo(0, 0);
      } else if (t === 'bottom') {
        window.scrollTo(0, document.documentElement.scrollHeight);
      } else {
        window.scrollBy(0, (Number(p) || 1) * window.innerHeight * 0.9);
      }
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      return { y: Math.round(window.scrollY), max: Math.round(max), atBottom: window.scrollY >= max - 2 };
    },
    args: [to || null, pages == null ? null : Number(pages), selector || null],
  });
  const out = res && res.result;
  if (!out) throw new CmdError('INTERNAL', 'No result from page.');
  if (out.error) throw new CmdError('NOT_FOUND', out.error);
  return { tabId, ...out };
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
  // captureVisibleTab can only capture the tab actually VISIBLE in its window.
  // Returning some other tab's pixels labeled with this tabId would silently
  // poison an agent's reasoning about the page — refuse instead and say how to
  // proceed. (We deliberately do NOT auto-activate: stealing the user's focus is
  // a `control` action the caller must take explicitly.)
  if (!tab.active) {
    throw new CmdError('NOT_VISIBLE', `Tab ${tabId} is not the visible tab of its window — screenshots capture only the visible tab. Activate it first (tab.activate) or use page.read for content.`);
  }
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
  setTabRecordingBadge(tabId, true); // red ● on this tab's icon
  updateIcon(); // refresh icon color + title
  // The bridge writes to <os.tmpdir()>/browser-bridge/<sessionKey>/.
  return { tabId, sessionKey };
}

async function monitorStop(tabId) {
  const rec = monitored.get(tabId);
  if (!rec) return { tabId, stopped: false };
  emitMonitor(tabId, { kind: 'session', event: 'stop', eventCount: rec.eventCount });
  if (rec.shotTimer) clearTimeout(rec.shotTimer);
  monitored.delete(tabId);
  setTabRecordingBadge(tabId, false); // clear this tab's ●
  updateIcon(); // back to blue (connected, idle) if nothing else recording
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

// ---------------------------------------------------------------------------
// Overlay mode — draw the bridge's OWN annotations on top of a tab the user is
// browsing: a badge beside each match, hover detail, and optional dim/strike of
// the enclosing card. This is a GENERIC capability — the bridge sends match rules
// (text / href / urlPattern / selector) and we render them. No domain knowledge
// (VINs, listings, …) lives here; that belongs to whichever module built the rules.
//
// State is EPHEMERAL BY DESIGN and lives in chrome.storage.session: it survives
// MV3 service-worker suspension and dies when the browser closes. Annotations are
// render state, never a notes database — the agent owns the durable list.
// ---------------------------------------------------------------------------

const OVERLAY_KEY = 'overlayRules'; // session: { [tabId]: rules[] }
const OVERLAY_SEEN_KEY = 'overlaySeen'; // session: { [tabId]: { matched[], visible[], ts } }
const overlaySeenAt = new Map(); // tabId -> last write ms (throttle scan reports)

async function sessGet(key) {
  try { const o = await chrome.storage.session.get(key); return (o && o[key]) || {}; } catch { return {}; }
}
async function sessSet(key, val) { try { await chrome.storage.session.set({ [key]: val }); } catch { /* best effort */ } }

async function overlayRulesFor(tabId) { return (await sessGet(OVERLAY_KEY))[String(tabId)] || []; }
async function overlayStore(tabId, rules) {
  const all = await sessGet(OVERLAY_KEY);
  if (rules && rules.length) all[String(tabId)] = rules; else delete all[String(tabId)];
  await sessSet(OVERLAY_KEY, all);
}

// Push the current rule set into the page. Re-running the injected function is how
// updates are delivered (there is no SW→page channel); it installs once and then
// just re-renders, so this is safe to call repeatedly.
async function overlayPush(tabId, rules) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: __bridgeOverlay, args: [rules || []] });
    return true;
  } catch (e) { return false; } // chrome://, PDF viewer, etc.
}

// The overlay engine, injected into the ISOLATED world. Must be self-contained
// (no closure over extension scope) and idempotent — executeScript re-runs it on
// every update and on every navigation.
function __bridgeOverlay(rules) {
  const MARK = 'data-bridge-ann';
  const LEGACY_MARK = 'data-aibridge-ann'; // pre-rename injections — always cleaned up
  const DIM = '__bridge-dim', STRIKE = '__bridge-strike', HIDE = '__bridge-hide';
  const S = window.__bridgeOverlayState || (window.__bridgeOverlayState = { rules: [], timer: null, rtimer: null, rendering: false, panels: new Set() });
  S.rules = Array.isArray(rules) ? rules : [];
  // Neutralize a pre-rename engine left injected before an extension reload: emptying
  // its rule set stops its own observer from re-rendering stale badges alongside ours.
  try { if (window.__aibridgeOverlayState) window.__aibridgeOverlayState.rules = []; } catch (e) {}

  const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
  // Only allow simple CSS color tokens — this value lands in a stylesheet.
  const safeColor = (c) => (/^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]{3,20})$/i.test(String(c || '')) ? String(c) : '#3b82f6');
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function ensureStyle() {
    const legacy = document.getElementById('__aibridge-ann-style');
    if (legacy) legacy.remove();
    if (document.getElementById('__bridge-ann-style')) return;
    const st = document.createElement('style');
    st.id = '__bridge-ann-style';
    st.textContent =
      '.' + DIM + '{opacity:.4 !important;filter:grayscale(.8) !important}' +
      '.' + STRIKE + '{text-decoration:line-through !important;text-decoration-color:#f85149 !important;text-decoration-thickness:2px !important}' +
      '.' + HIDE + '{display:none !important}';
    (document.head || document.documentElement).appendChild(st);
  }

  function clearAll() {
    document.querySelectorAll('[' + MARK + '],[' + LEGACY_MARK + ']').forEach((n) => n.remove());
    [DIM, STRIKE, HIDE, '__aibridge-dim', '__aibridge-strike', '__aibridge-hide']
      .forEach((c) => document.querySelectorAll('.' + c).forEach((n) => n.classList.remove(c)));
    S.panels.clear();
  }

  // Badge lives in a CLOSED shadow root inside an `all:initial` host, so page CSS
  // cannot restyle it and our CSS cannot leak out. Text only — never innerHTML
  // with rule-supplied strings, and never a rule-supplied link target.
  function makeBadge(rule) {
    const host = document.createElement('span');
    host.setAttribute(MARK, cut(rule.key, 120) || '1');
    host.style.cssText = 'all:initial;display:inline-block;vertical-align:middle;margin:0 4px';
    const sh = host.attachShadow({ mode: 'closed' });
    const color = safeColor(rule.badge && rule.badge.color);
    const st = document.createElement('style');
    st.textContent =
      ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,system-ui,"Segoe UI",sans-serif}' +
      '.b{display:inline-flex;align-items:center;gap:4px;background:' + color + ';color:#fff;font-size:11px;font-weight:600;' +
      'line-height:1.45;padding:2px 7px;border-radius:5px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;position:relative}' +
      '.m{opacity:.65;font-size:9px}' +
      '.p{position:absolute;z-index:2147483647;left:0;top:calc(100% + 5px);min-width:210px;max-width:340px;background:#14161b;color:#e6e8ec;' +
      'border:1px solid #2a2f3a;border-radius:8px;padding:9px 10px;box-shadow:0 8px 26px rgba(0,0,0,.5);display:none;cursor:default;text-align:left}' +
      '.b:hover .tip,.p.open{display:block}' +
      '.b.mopen .tip{display:none !important}' +
      '.h{font-size:9px;text-transform:uppercase;letter-spacing:.5px;opacity:.5;margin-bottom:5px;font-weight:700}' +
      '.tx{font-size:11px;font-weight:400;line-height:1.5;white-space:pre-wrap;word-break:break-word}' +
      '.row{display:flex;gap:5px;margin-top:9px}' +
      'button{flex:1;font-size:10px;font-weight:600;padding:4px 0;border-radius:5px;border:1px solid #2a2f3a;background:#1c2027;color:#e6e8ec;cursor:pointer}' +
      'button:hover{border-color:#3b82f6}' +
      'input{width:100%;margin-top:7px;font-size:11px;padding:4px 6px;border-radius:5px;border:1px solid #2a2f3a;background:#0f1115;color:#e6e8ec}';
    const b = document.createElement('span'); b.className = 'b';
    const mk = document.createElement('span'); mk.className = 'm'; mk.textContent = '◆'; // Browser Bridge marker
    const lb = document.createElement('span'); lb.textContent = cut((rule.badge && rule.badge.label) || 'note', 56);
    b.append(mk, lb);

    // Hover detail (suppressed via .mopen while the mark panel is open).
    const tip = document.createElement('span'); tip.className = 'p tip';
    const th = document.createElement('span'); th.className = 'h'; th.textContent = 'Browser Bridge · note';
    const tt = document.createElement('span'); tt.className = 'tx';
    tt.textContent = cut((rule.badge && rule.badge.tooltip) || (rule.badge && rule.badge.label) || '', 900);
    tip.append(th, tt);

    // Click → mark menu. The mark is HMAC-signed by the service worker and sent to
    // the bridge (and into the recording when the tab is recorded).
    const pan = document.createElement('span'); pan.className = 'p';
    const ph = document.createElement('span'); ph.className = 'h'; ph.textContent = 'Mark ' + (cut(rule.key, 24) || 'this');
    const inp = document.createElement('input'); inp.placeholder = 'reason (optional)';
    // Typing in the reason field must not bubble to the badge toggle (which would
    // close the panel mid-click) or to the page's own hotkey handlers.
    for (const ev of ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'keypress']) {
      inp.addEventListener(ev, (e) => e.stopPropagation());
    }
    const row = document.createElement('span'); row.className = 'row';
    const note = document.createElement('span'); note.className = 'tx'; note.style.cssText = 'display:block;margin-top:7px;opacity:.6';
    for (const act of ['pass', 'watch', 'note']) {
      const btn = document.createElement('button');
      btn.textContent = act;
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        try {
          chrome.runtime.sendMessage({ type: 'OVERLAY_ACTION', key: cut(rule.key, 120), action: act, reason: cut(inp.value, 400) })
            .then((r) => {
              note.textContent = r && r.delivered ? 'Sent to your agent ✓'
                : (r && r.recorded ? 'Saved to the recording ✓' : 'Bridge offline — mark not delivered.');
            })
            .catch(() => { note.textContent = 'Could not reach the bridge.'; });
        } catch (e2) { note.textContent = 'Could not reach the bridge.'; }
      });
      row.appendChild(btn);
    }
    pan.append(ph, inp, row, note);

    const ref = { host, close: () => setOpen(false) };
    function setOpen(open) {
      pan.classList.toggle('open', open);
      b.classList.toggle('mopen', open);
      if (open) S.panels.add(ref); else S.panels.delete(ref);
    }
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      setOpen(!pan.classList.contains('open'));
    });
    b.append(tip, pan);
    sh.append(st, b);
    return host;
  }

  function globRe(p) {
    return new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '.*' : '\\' + m)) + '$', 'i');
  }

  function applyCard(c, card) {
    if (card.dim) c.classList.add(DIM);
    if (card.strike) c.classList.add(STRIKE);
    if (card.hide) c.classList.add(HIDE);
  }

  // Nearest ancestor that looks like a listing card, for dim/strike. Refuses any
  // container that also holds a DIFFERENT rule's match — that container spans more
  // than one listing, and dimming it would strike an innocent neighbour.
  function cardOf(el, sel, key, targets) {
    if (sel) { try { const c = el.closest(sel); if (c) return c; } catch (e) {} }
    let n = el;
    for (let i = 0; i < 12 && n && n.parentElement && n.parentElement !== document.body; i++) {
      n = n.parentElement;
      const h = n.offsetHeight || 0;
      if (h >= 70 && h <= 1500 && n.querySelector('a[href]')) {
        const foreign = targets.some((t) => t.r.key !== key && t.el !== el && n.contains(t.el));
        return foreign ? null : n;
      }
    }
    return null;
  }

  function textTargets(needle) {
    const out = [];
    if (!needle || !document.body) return out;
    const want = String(needle).toUpperCase();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const v = n.nodeValue;
        if (!v || v.length > 5000 || v.toUpperCase().indexOf(want) < 0) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TITLE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = w.nextNode()) && out.length < 25) if (out.indexOf(n.parentElement) < 0) out.push(n.parentElement);
    return out;
  }

  // Match an id inside link hrefs with a BOUNDARY: "/15934651" must not also light
  // up "/159346512" (numerically adjacent ids are real on auction sites). The
  // character after the match must not continue the id.
  function hrefTargets(v) {
    let re;
    try { re = new RegExp(escRe(v) + '(?![A-Za-z0-9])'); } catch (e) { return []; }
    return Array.prototype.slice.call(document.querySelectorAll('a[href]'))
      .filter((a) => re.test(a.getAttribute('href') || '')).slice(0, 25);
  }

  function render() {
    if (!document.body) return;
    // Never tear down a mark panel the user has open — defer until it closes.
    for (const p of Array.from(S.panels)) if (!p.host || !p.host.isConnected) S.panels.delete(p);
    if (S.panels.size) { clearTimeout(S.timer); S.timer = setTimeout(render, 400); return; }
    S.rendering = true; // our own DOM writes must not re-trigger the observer → render loop
    try {
      ensureStyle();
      clearAll();
      // Pass 1: find every match first, so card styling can tell when a container
      // spans MORE than one annotated listing.
      const targets = []; // { r, el, after }
      for (const r of S.rules) {
        if (!r || !r.match) continue;
        try {
          if (r.match.text) { for (const el of textTargets(r.match.text)) targets.push({ r, el, after: false }); }
          else if (r.match.href) { for (const el of hrefTargets(String(r.match.href))) targets.push({ r, el, after: true }); } // never nest the badge inside the link
          else if (r.match.selector) { for (const el of Array.prototype.slice.call(document.querySelectorAll(r.match.selector)).slice(0, 25)) targets.push({ r, el, after: false }); }
          else if (r.match.urlPattern) {
            if (globRe(r.match.urlPattern).test(location.href)) {
              // Whole page is this item → fixed banner, top-right.
              const badge = makeBadge(r);
              badge.style.cssText = 'all:initial;display:block;position:fixed;top:12px;right:12px;z-index:2147483647';
              document.body.appendChild(badge);
              const c = r.cardSelector ? document.querySelector(r.cardSelector) : null;
              if (c && r.card) applyCard(c, r.card);
            }
          }
        } catch (e) { continue; }
      }
      // Pass 2: badge + card styling.
      for (const t of targets) {
        const r = t.r, el = t.el;
        if (!el || !el.isConnected || el.closest('[' + MARK + ']')) continue;
        try {
          const badge = makeBadge(r);
          if (t.after) el.insertAdjacentElement('afterend', badge); else el.appendChild(badge);
          if (r.card) {
            const c = cardOf(el, r.cardSelector, r.key, targets);
            if (c) applyCard(c, r.card);
          }
        } catch (e) { /* skip this target */ }
      }
    } finally {
      // Mutation records for our writes are delivered at the next microtask
      // checkpoint — before timers — so resetting on a 0ms timer skips exactly them.
      setTimeout(() => { S.rendering = false; }, 0);
    }
    report();
  }

  // Tell the SW which keys matched and which are on screen (our own rules only —
  // never page content, so this stays inside the `annotate` permission).
  function report() {
    const matched = [], visible = [];
    document.querySelectorAll('[' + MARK + ']').forEach((n) => {
      const k = n.getAttribute(MARK);
      if (!k || k === '1') return;
      if (matched.indexOf(k) < 0) matched.push(k);
      const r = n.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && visible.indexOf(k) < 0) visible.push(k);
    });
    try { chrome.runtime.sendMessage({ type: 'OVERLAY_SEEN', matched, visible }).catch(() => {}); } catch (e) {}
  }

  const schedule = () => { clearTimeout(S.timer); S.timer = setTimeout(render, 160); };

  if (!window.__bridgeOverlayInstalled) {
    window.__bridgeOverlayInstalled = true;
    // Re-apply on DOM churn (infinite scroll, lazy lists) and on SPA route changes —
    // there is no webNavigation permission and tabs.onUpdated does not re-inject on
    // History API URL changes, so the page has to notice for itself. S.rendering
    // suppresses the mutations render itself makes (else this loops forever).
    try {
      new MutationObserver(() => { if (!S.rendering && S.rules.length) schedule(); })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    for (const m of ['pushState', 'replaceState']) {
      try {
        const o = history[m];
        history[m] = function () { const r = o.apply(this, arguments); schedule(); return r; };
      } catch (e) {}
    }
    addEventListener('popstate', schedule);
    addEventListener('scroll', () => { clearTimeout(S.rtimer); S.rtimer = setTimeout(report, 300); }, true);
    // Clicking anywhere outside a badge closes any open mark panel. Badge internals
    // are retargeted to their shadow host (which carries MARK), so they don't match.
    addEventListener('click', (e) => {
      if (!S.panels.size) return;
      const t = e.target;
      if (t && t.closest && (t.closest('[' + MARK + ']') || t.closest('[' + LEGACY_MARK + ']'))) return;
      for (const p of Array.from(S.panels)) { try { p.close(); } catch (err) {} }
    }, true);
  }

  render();
  return { ok: true, rules: S.rules.length };
}

async function overlaySet(params) {
  const tabId = params && params.tabId;
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  const incoming = Array.isArray(params.rules) ? params.rules : [];
  if (incoming.length > 500) throw new CmdError('BAD_REQUEST', 'Too many rules (max 500).');
  for (const r of incoming) {
    if (!r || typeof r.key !== 'string' || !r.key) throw new CmdError('BAD_REQUEST', 'every rule needs a string `key`.');
    const m = r.match;
    if (!m || typeof m !== 'object' || !(m.text || m.href || m.selector || m.urlPattern)) {
      throw new CmdError('BAD_REQUEST', `rule "${r.key}": match must set one of text | href | selector | urlPattern.`);
    }
  }
  const merge = params.merge !== false; // default: merge by key
  let rules = incoming;
  if (merge) {
    const prev = await overlayRulesFor(tabId);
    const byKey = new Map(prev.map((r) => [r.key, r]));
    for (const r of incoming) byKey.set(r.key, r);
    rules = Array.from(byKey.values()).slice(-500);
  }
  const applied = await overlayPush(tabId, rules);
  if (!applied) throw new CmdError('FORBIDDEN', 'Cannot annotate this tab (not an injectable page).');
  await overlayStore(tabId, rules);
  return { tabId, rules: rules.length, annotated: true };
}

async function overlayClear(params) {
  const tabId = params && params.tabId;
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  let rules = [];
  if (Array.isArray(params.keys) && params.keys.length) {
    const drop = new Set(params.keys.map(String));
    rules = (await overlayRulesFor(tabId)).filter((r) => !drop.has(r.key));
  }
  await overlayPush(tabId, rules);
  await overlayStore(tabId, rules);
  // Keep the seen-report consistent with what remains, so overlay.list doesn't
  // claim removed keys are still matched until the next in-page scan.
  const seen = await sessGet(OVERLAY_SEEN_KEY);
  const cur = seen[String(tabId)];
  if (!rules.length) delete seen[String(tabId)];
  else if (cur) {
    const keep = new Set(rules.map((r) => r.key));
    cur.matched = (cur.matched || []).filter((k) => keep.has(k));
    cur.visible = (cur.visible || []).filter((k) => keep.has(k));
  }
  await sessSet(OVERLAY_SEEN_KEY, seen);
  return { tabId, rules: rules.length, cleared: true };
}

async function overlayList(params) {
  const tabId = params && params.tabId;
  if (typeof tabId !== 'number') throw new CmdError('BAD_REQUEST', 'params.tabId (number) required.');
  const rules = await overlayRulesFor(tabId);
  const seen = (await sessGet(OVERLAY_SEEN_KEY))[String(tabId)] || { matched: [], visible: [] };
  return {
    tabId,
    keys: rules.map((r) => r.key),
    matchedOnPage: seen.matched || [],
    visibleOnScreen: seen.visible || [],
    reportedAt: seen.ts || null,
  };
}

// Re-apply annotations after a full load wipes injected scripts. Separate listener
// from the monitor's so the two features stay independent.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  overlayRulesFor(tabId).then((rules) => { if (rules.length) overlayPush(tabId, rules); }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  overlayStore(tabId, []).catch(() => {});
  overlaySeenAt.delete(tabId);
  sessGet(OVERLAY_SEEN_KEY).then((s) => { if (s[String(tabId)]) { delete s[String(tabId)]; return sessSet(OVERLAY_SEEN_KEY, s); } }).catch(() => {});
});

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
      // The EFFECTIVE url (what the socket actually dials), not the stored one —
      // in embedded mode they differ and showing the stored one sends people
      // looking at the wrong port. Strip the token: the popup only displays this.
      const bridgeUrl = (await effectiveBridgeUrl()).replace(/([?&])token=[^&]*/, '$1token=***');
      const ident = await ensureBrowserIdentity();
      return {
        running: true,
        version: VERSION,
        locked: !(await getPairKey()), // "locked" = not linked yet
        wsConnected,
        bridgeUrl,
        monitored: monitorList(),
        paired: !!(await getPairKey()),
        embedded: !!(await getEmbedded()),
        browserId: ident.id,
        browserName: ident.name,
        pairError,
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

    // Embedded mode has no open control plane, so the popup can't use /bridge/status.
    // The SW holds the launch token, so it fetches the bearer-gated /health here and
    // hands the popup just what it renders. Null when not embedded/unreachable.
    case 'embeddedStatus': {
      const emb = await getEmbedded();
      if (!emb) return null;
      const base = emb.bridgeUrl.replace(/^ws/, 'http').replace(/\/agent.*$/, '');
      try {
        const r = await fetch(base + '/health', { headers: { authorization: 'Bearer ' + emb.token }, cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }

    case 'moduleDecision': {
      return await submitModuleDecision(msg.reqId, !!msg.approve);
    }

    case 'oauthDecision': {
      return await submitOauthDecision(msg.reqId, !!msg.approve);
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
      await sendToOffscreen({ type: 'CONFIG', bridgeUrl: await effectiveBridgeUrl(), version: VERSION }).catch(() => {}); // embedded config wins over a user-set URL
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown popup action: ${msg.action}` };
  }
}
