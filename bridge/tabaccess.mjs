// tabaccess.mjs — which tabs the bridge may touch at all.
//
// Replaces the 2.0-era rules engine. That engine gated every call as
// (agent → destination : permission), which meant a matrix nobody edited standing
// between the user and their own browser. In 2.0 an authorized agent gets every
// primitive, and the ONE control that remains is the one people actually reason
// about: which sites are in scope. Modules are checked identically — a module
// cannot reach a tab the user hasn't enabled.
//
// Deny-by-default: a fresh install is `none` and grants nothing until the user says so.

import { state, save } from './state.mjs';

// The capability names. No longer gates — labels, used by module manifests to declare
// what they do and by the UI to describe them.
export const CAPABILITIES = ['read', 'write', 'control', 'record', 'annotate'];

// --- Pattern matching --------------------------------------------------------
// Escape regex specials INCLUDING '*' (so it becomes \*), then turn \* into .*
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
const globRe = (p) => new RegExp('^' + escapeRe(p).replace(/\\\*/g, '.*') + '$', 'i');

// Does `pattern` cover `url`? Supports exact origin, host wildcard (*.acvauctions.com),
// URL prefix (https://acme.com/app/*), bare host, and '*' (everything).
export function matchPattern(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const isHttp = u.protocol === 'http:' || u.protocol === 'https:';
  if (!isHttp) return pattern === url || pattern === u.origin; // non-http: explicit only
  const hasScheme = /^https?:\/\//i.test(pattern);
  const rx = globRe(pattern);
  if (hasScheme) return rx.test(u.origin) || rx.test(u.href);
  if (rx.test(u.host) || rx.test(u.hostname)) return true;
  // "*.example.com" is read by everyone as "example.com and its subdomains" — the bare
  // apex included. A strict glob excludes the apex, so enabling a site from its www URL
  // would silently fail on the naked domain. Only the leading-"*." form widens; a
  // pattern with a wildcard elsewhere stays literal.
  if (pattern.startsWith('*.')) {
    const apex = pattern.slice(2);
    if (apex && !apex.includes('*')) return u.hostname.toLowerCase() === apex.toLowerCase();
  }
  return false;
}

// --- The setting -------------------------------------------------------------
export function tabAccess() {
  const t = state.tabAccess || (state.tabAccess = { mode: 'none', origins: [] });
  if (!Array.isArray(t.origins)) t.origins = [];
  if (!['all', 'selected', 'none'].includes(t.mode)) t.mode = 'none';
  return t;
}

export function setTabAccess({ mode, origins }) {
  const t = tabAccess();
  if (mode && ['all', 'selected', 'none'].includes(mode)) t.mode = mode;
  if (Array.isArray(origins)) t.origins = origins.map(String).filter(Boolean).slice(0, 200);
  save();
  return { ok: true, tabAccess: { ...t } };
}

// Add/remove one origin pattern, flipping into `selected` so the click does what it looks
// like it does rather than silently having no effect while the mode says none/all.
export function toggleOrigin(origin) {
  const t = tabAccess();
  const o = String(origin || '').trim();
  if (!o) return { ok: false, error: 'origin required' };
  if (t.mode !== 'selected') { t.mode = 'selected'; if (!t.origins.length && o) t.origins = []; }
  const i = t.origins.indexOf(o);
  if (i >= 0) t.origins.splice(i, 1); else t.origins.push(o);
  save();
  return { ok: true, tabAccess: { ...t } };
}

// --- The check ---------------------------------------------------------------
// `url` may be null for calls that target no particular tab (tabs.list, monitor.list…).
// Those are allowed whenever access isn't fully off; their RESULTS are filtered by the
// caller so a disabled tab is never revealed.
export function urlAllowed(url) {
  const t = tabAccess();
  if (t.mode === 'none') return { allow: false, reason: 'tab access is off — enable tabs in the control panel' };
  if (t.mode === 'all') return { allow: true, reason: 'all tabs enabled' };
  if (!url) return { allow: true, reason: 'no specific tab' };
  const hit = t.origins.find((p) => matchPattern(p, url));
  return hit
    ? { allow: true, reason: `matches ${hit}` }
    : { allow: false, reason: `${safeHost(url)} is not an enabled tab — add it in the control panel` };
}
const safeHost = (u) => { try { return new URL(u).host; } catch { return String(u || '').slice(0, 60); } };

// --- Recording storage class -------------------------------------------------
// Where a tab's recording lands: `tmp` ($TMPDIR, cleared by the OS) or `perm`
// (browser-bridge/recordings, kept). This was module state in 1.x, which meant the
// answer to "where did my recording go" depended on which module you had installed.
// It's a bridge setting now, with a per-origin override.
export function recordingCfg() {
  const r = state.recording || (state.recording = { default: 'tmp', byOrigin: {} });
  if (r.default !== 'perm') r.default = 'tmp';
  if (!r.byOrigin || typeof r.byOrigin !== 'object') r.byOrigin = {};
  return r;
}

export function storageFor(url) {
  const r = recordingCfg();
  let origin = '';
  try { origin = new URL(url).origin; } catch { return r.default; }
  const v = r.byOrigin[origin];
  return v === 'perm' || v === 'tmp' ? v : r.default;
}

export function setStorageDefault(value) {
  recordingCfg().default = value === 'perm' ? 'perm' : 'tmp';
  save();
  return { ok: true, recording: { ...recordingCfg() } };
}

// Toggle one origin between tmp and perm. Clearing back to the default is what you get
// by toggling twice past it, so the map never accumulates entries equal to the default.
export function toggleStorage(origin) {
  const r = recordingCfg();
  const o = String(origin || '').trim();
  if (!o) return { ok: false, error: 'origin required' };
  const cur = r.byOrigin[o] || r.default;
  const next = cur === 'perm' ? 'tmp' : 'perm';
  if (next === r.default) delete r.byOrigin[o]; else r.byOrigin[o] = next;
  save();
  return { ok: true, recording: { ...r } };
}

// --- tabId → URL resolution (small cache over relayed tabs.list) -------------
let _relay = null;
const tabCache = new Map(); // tabId -> { url, ts }
const TAB_TTL_MS = 2500;

export function configureTabAccess({ relayCommand }) { _relay = relayCommand; }

async function refreshTabs() {
  if (!_relay) return;
  try {
    const tabs = await _relay('tabs.list');
    const now = Date.now();
    for (const t of tabs || []) if (typeof t.tabId === 'number') tabCache.set(t.tabId, { url: t.url || '', ts: now });
  } catch { /* extension offline */ }
}

export async function resolveTabUrl(tabId) {
  const c = tabCache.get(tabId);
  if (c && Date.now() - c.ts < TAB_TTL_MS) return c.url;
  await refreshTabs();
  const c2 = tabCache.get(tabId);
  return c2 ? c2.url : null;
}
