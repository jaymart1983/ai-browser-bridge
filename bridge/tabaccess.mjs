// tabaccess.mjs — which tabs the bridge may touch at all.
//
// Replaces the 2.0-era rules engine. That engine gated every call as
// (agent → destination : permission), which meant a matrix nobody edited standing
// between the user and their own browser. In 2.0 an authorized agent gets every
// primitive, and the ONE control that remains is the one people actually reason
// about: which sites are in scope. Modules are checked identically — a module
// cannot reach a tab the user hasn't enabled.
//
// Deny-by-default: a fresh install has default `off` and grants nothing until you say so.

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
// A DEFAULT plus per-site OVERRIDES, rather than a mode that swallows the per-tab
// controls. The old three-mode setting conflated two different things: "what should a
// site I haven't decided about get" and "turn everything on/off right now". Picking
// "All tabs" then disabled every individual switch, so there was no way to say
// "everything except this one" — and no way to say "nothing except this one" without
// hunting for the right mode first. Now the default answers the first question, an
// explicit override answers the second, and both directions work.
//
// `origins` is a map pattern -> true|false, and an entry SURVIVES even when it happens to
// agree with the current default. Auto-dropping redundant entries looked tidy but lost
// real decisions: turn the default off for an hour ("pause everything"), turn it back on,
// and the site you had deliberately excluded would silently be allowed again. An explicit
// setting is only removed when you explicitly clear it ("Use default").
export function tabAccess() {
  const t = state.tabAccess || (state.tabAccess = { default: 'off', origins: {} });
  // Migrate the 2.0.0–2.0.5 shape (mode + array) in place.
  if (t.mode) {
    const list = Array.isArray(t.origins) ? t.origins : [];
    t.default = t.mode === 'all' ? 'on' : 'off';
    t.origins = {};
    if (t.mode === 'selected') for (const p of list) t.origins[p] = true;
    delete t.mode;
    save();
  }
  if (t.default !== 'on') t.default = 'off';
  if (!t.origins || typeof t.origins !== 'object' || Array.isArray(t.origins)) t.origins = {};
  return t;
}

const defaultOn = () => tabAccess().default === 'on';

// The explicit setting for a pattern, or null when it just follows the default.
export function originSetting(pattern) {
  const v = tabAccess().origins[pattern];
  return typeof v === 'boolean' ? v : null;
}

export function setDefaultAccess(on) {
  const t = tabAccess();
  t.default = on ? 'on' : 'off';
  // Explicit per-site settings are NOT pruned here — see the note above.
  save();
  return { ok: true, tabAccess: { ...t } };
}

// Set one site explicitly. Passing null clears the override (back to following default).
export function setOriginAccess(pattern, on) {
  const t = tabAccess();
  const p = String(pattern || '').trim();
  if (!p) return { ok: false, error: 'origin required' };
  if (on === null) delete t.origins[p]; // "Use default" — the only way to forget a site
  else t.origins[p] = !!on;
  if (Object.keys(t.origins).length > 400) return { ok: false, error: 'too many site overrides' };
  save();
  return { ok: true, tabAccess: { ...t } };
}

export function toggleOrigin(pattern) {
  const cur = originSetting(pattern);
  const effective = cur === null ? defaultOn() : cur;
  return setOriginAccess(pattern, !effective);
}

// Bulk: force every listed site to on/off. Used by the column header control, which
// operates on exactly the tabs currently listed — not on the default, so a bulk action
// never silently changes what future tabs get.
export function setManyAccess(patterns, on) {
  for (const p of patterns) setOriginAccess(p, on);
  return { ok: true, tabAccess: { ...tabAccess() } };
}

// Kept for the /bridge/tabaccess POST body and tests.
export function setTabAccess({ default: dflt, origins }) {
  const t = tabAccess();
  if (dflt === 'on' || dflt === 'off') t.default = dflt;
  if (origins && typeof origins === 'object' && !Array.isArray(origins)) {
    t.origins = {};
    for (const [k, v] of Object.entries(origins)) if (typeof v === 'boolean') t.origins[String(k)] = v;
  }
  save();
  return { ok: true, tabAccess: { ...t } };
}

// --- The check ---------------------------------------------------------------
// `url` may be null for calls that target no particular tab (tabs.list, monitor.list…).
// Those are allowed whenever anything at all is reachable; their RESULTS are filtered by
// the caller so a disabled tab is never revealed.
export function urlAllowed(url) {
  const t = tabAccess();
  const on = t.default === 'on';
  if (!url) {
    // Nothing reachable at all = deny even the untargeted calls, so "off" really is off.
    const anyAllowed = on || Object.values(t.origins).some(Boolean);
    return anyAllowed
      ? { allow: true, reason: 'no specific tab' }
      : { allow: false, reason: 'tab access is off — turn on tabs in the control panel' };
  }
  // An explicit setting always wins over the default, in both directions. When SEVERAL
  // patterns match, the most specific one wins (longest pattern), and a tie goes to deny
  // — otherwise the answer would depend on the order entries happened to be added, which
  // is not something anyone can reason about for a security setting.
  const hits = Object.keys(t.origins).filter((p) => matchPattern(p, url));
  if (hits.length) {
    hits.sort((a, b) => (b.length - a.length) || (t.origins[a] === t.origins[b] ? 0 : t.origins[a] ? 1 : -1));
    const win = hits[0];
    return t.origins[win]
      ? { allow: true, reason: `matches ${win}` }
      : { allow: false, reason: `${safeHost(url)} is turned off (${win})` };
  }
  if (on) return { allow: true, reason: 'default is on' };
  return { allow: false, reason: `${safeHost(url)} is not turned on — enable it in the control panel` };
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
  return setStorageFor(o, (r.byOrigin[o] || r.default) === 'perm' ? 'tmp' : 'perm');
}

export function setStorageFor(origin, value) {
  const r = recordingCfg();
  const o = String(origin || '').trim();
  if (!o) return { ok: false, error: 'origin required' };
  const v = value === 'perm' ? 'perm' : 'tmp';
  if (v === r.default) delete r.byOrigin[o]; else r.byOrigin[o] = v;
  save();
  return { ok: true, recording: { ...r } };
}

// Bulk, for the storage column header. Same rule as access: acts on the listed sites,
// never on the default.
export function setManyStorage(origins, value) {
  for (const o of origins) setStorageFor(o, value);
  return { ok: true, recording: { ...recordingCfg() } };
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
