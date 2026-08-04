// pairing.mjs — ECDH pairing between the bridge and one OR MORE browsers.
// After the user clicks "Link" in a browser's popup, that browser and the bridge
// derive a shared HMAC key. The bridge signs every command frame it relays with
// the ACTIVE browser's key; each extension only executes frames it can verify.
//
// Multiple browsers can be linked at once (each keeps its own key + identity). At
// any moment exactly one is the ACTIVE browser — the one that receives relayed
// commands. Switch it from the bridge Config page or the extension's "Use this
// browser" button. A single legacy pairing (pre-multi-browser) is migrated to a
// browser entry on first identified connect, so existing links keep working.

import { createECDH, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { state, save } from './state.mjs';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function canon(frame) { return frame.id + '\n' + frame.method + '\n' + stableStringify(frame.params || {}); }

// EMBEDDED MODE: no interactive pairing. The host application launches both the
// bridge and its extension with a shared per-launch token; both sides derive the
// frame-signing key as SHA-256(token), so the existing signed-frame verification
// works unchanged with zero ceremony. Set once at boot by server.mjs.
let embeddedKey = null;
export function configureEmbeddedPairing(tokenUtf8) {
  embeddedKey = tokenUtf8 ? createHash('sha256').update(String(tokenUtf8), 'utf8').digest('hex') : null;
}

// The key used to sign relayed frames = the embedded key when in embedded mode,
// else the ACTIVE browser's key (falling back to a legacy single-pairing key).
function activeKey() {
  if (embeddedKey) return embeddedKey;
  const b = state.activeBrowser && state.browsers[state.activeBrowser];
  if (b && b.key) return b.key;
  return (state.pairing && state.pairing.key) || null;
}
export function isPaired() { return !!activeKey(); }

// Backward-compatible status for the popup/Config "linked" line — reflects the
// ACTIVE browser (or the legacy pairing).
export function pairingStatus() {
  if (embeddedKey) return { paired: true, created: 0, embedded: true };
  const b = state.activeBrowser && state.browsers[state.activeBrowser];
  if (b) return { paired: true, created: b.created || 0, activeBrowser: b.id, activeName: b.name || '' };
  if (state.pairing && state.pairing.key) return { paired: true, created: state.pairing.created || 0 };
  return { paired: false, created: 0 };
}

// All linked browsers, tagged with live connection + active flags.
export function listBrowsers(connected = new Set()) {
  return Object.values(state.browsers)
    .map((b) => ({ id: b.id, name: b.name || 'Browser', created: b.created || 0, lastSeen: b.lastSeen || 0, connected: connected.has(b.id), active: b.id === state.activeBrowser }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

export function setActiveBrowser(browserId) {
  if (state.browsers[browserId]) { state.activeBrowser = browserId; save(); return { ok: true, activeBrowser: browserId }; }
  return { ok: false, error: 'unknown browser' };
}

export function touchBrowser(browserId, name) {
  const b = state.browsers[browserId];
  // NEVER let the extension's auto-detected name overwrite one the user chose. The
  // extension reports its UA-derived guess ("Chrome") on every reconnect, so without
  // this a rename silently reverts the next time the browser attaches — which is the
  // whole point of renaming when two Chromium forks both report "Chrome".
  if (b) { b.lastSeen = Date.now(); if (name && !b.renamed) b.name = name; save(); return true; }
  return false;
}

// Set a friendly label for a linked browser. Indistinguishable Chromium forks (Island,
// Arc, plain Chromium) all report the UA name "Chrome", so let the user relabel one to
// tell them apart. Returns { ok, name } or { ok:false, error }.
export function renameBrowser(browserId, name) {
  const b = state.browsers[browserId];
  if (!b) return { ok: false, error: 'unknown browser' };
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return { ok: false, error: 'name required' };
  // `renamed` marks this as the USER's choice, so reconnects stop re-applying the
  // browser's own guess (see touchBrowser).
  b.name = clean; b.renamed = true; save();
  return { ok: true, name: clean };
}

// Migrate a legacy single pairing onto the browserId the (already-linked) extension
// now reports — so it keeps working WITHOUT re-linking. Retires the legacy slot.
export function adoptLegacyForBrowser(browserId, name) {
  if (!browserId || state.browsers[browserId]) return false;
  if (Object.keys(state.browsers).length > 0) return false; // only migrate the FIRST browser
  if (!(state.pairing && state.pairing.key)) return false;
  state.browsers[browserId] = { id: browserId, name: name || 'This browser', key: state.pairing.key, created: state.pairing.created || Date.now(), lastSeen: Date.now() };
  if (!state.activeBrowser) state.activeBrowser = browserId;
  state.pairing = null;
  save();
  return true;
}

// Complete a pairing. With a browserId → store/replace that browser's key (and make
// it active if nothing else is). Without → legacy single pairing. Returns the
// bridge's ECDH public key (hex).
export function pairInit(extPubHex, browserId, name) {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(extPubHex, 'hex'));
  const key = createHash('sha256').update(shared).digest('hex');
  if (browserId) {
    const prev = state.browsers[browserId];
    // Re-linking must not discard a user-chosen label either.
    const keepName = prev && prev.renamed ? prev.name : (name || (prev && prev.name) || 'Browser');
    state.browsers[browserId] = { id: browserId, name: keepName, renamed: !!(prev && prev.renamed), key, created: (prev && prev.created) || Date.now(), lastSeen: Date.now() };
    if (!state.activeBrowser) state.activeBrowser = browserId;
  } else {
    state.pairing = { key, paired: true, created: Date.now() };
  }
  save();
  return pub.toString('hex');
}

// Unlink one browser (or, with no id, clear the legacy pairing). If the active
// browser is removed, the newest remaining linked browser becomes active.
export function unpairBrowser(browserId) {
  if (browserId && state.browsers[browserId]) {
    delete state.browsers[browserId];
    if (state.activeBrowser === browserId) {
      const rest = Object.values(state.browsers).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      state.activeBrowser = rest.length ? rest[0].id : null;
    }
    save();
    return { ok: true };
  }
  state.pairing = null; save();
  return { ok: true };
}
export function unpair() { return unpairBrowser(null); }

export function signFrame(frame) {
  const key = activeKey();
  if (!key) return frame;
  frame.mac = createHmac('sha256', Buffer.from(key, 'hex')).update(canon(frame)).digest('hex');
  return frame;
}

export function verifyMac(frame) {
  const key = activeKey();
  if (!key || !frame.mac) return false;
  const expect = createHmac('sha256', Buffer.from(key, 'hex')).update(canon(frame)).digest('hex');
  try { return timingSafeEqual(Buffer.from(frame.mac), Buffer.from(expect)); } catch { return false; }
}

// Verify an overlay mark (the user's in-page Pass/Watch/Note click) was signed by a
// linked browser's pairing key. Same anti-fabrication gate as verifyDecision: only the
// paired extension holds a key, so unsigned local code cannot forge "the user decided
// X" and poison the agent's durable list. Canonical string MUST match the extension's
// construction in background.js (JSON array of the signed fields, in this order).
export function verifyMark(msg) {
  if (!msg || !msg.mac) return false;
  const canon = JSON.stringify([msg.ts, msg.tabId, msg.key, msg.action, msg.reason, msg.url]);
  const keys = Object.values(state.browsers || {}).map((b) => b.key).filter(Boolean);
  if (state.pairing && state.pairing.key) keys.push(state.pairing.key);
  if (embeddedKey) keys.push(embeddedKey);
  for (const k of keys) {
    try {
      const expect = createHmac('sha256', Buffer.from(k, 'hex')).update(canon).digest('hex');
      if (timingSafeEqual(Buffer.from(msg.mac), Buffer.from(expect))) return true;
    } catch { /* try next key */ }
  }
  return false;
}

// Verify an OAuth consent decision was signed by a LINKED browser's pairing key.
// This is the anti-self-approval gate: only the paired extension (a human clicking
// Approve) holds a key, so unsigned local code cannot approve a grant. Accepts a
// signature from ANY currently-linked browser (or the legacy pairing).
export function verifyDecision(reqId, approve, mac) {
  if (!reqId || !mac) return false;
  const msg = `${reqId}\n${approve ? 1 : 0}`;
  const keys = Object.values(state.browsers || {}).map((b) => b.key).filter(Boolean);
  if (state.pairing && state.pairing.key) keys.push(state.pairing.key);
  if (embeddedKey) keys.push(embeddedKey);
  for (const k of keys) {
    try {
      const expect = createHmac('sha256', Buffer.from(k, 'hex')).update(msg).digest('hex');
      if (timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return true;
    } catch { /* try next key */ }
  }
  return false;
}
