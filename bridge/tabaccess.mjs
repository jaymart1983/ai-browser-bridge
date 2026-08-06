// tabaccess.mjs — what the bridge may do, and where.
//
// One ordered rule list, read top to bottom, ending in a default line. Each row says
// what a matching site may be used for: read, control, record, annotate (plus where its
// recordings are kept). Agents and scheduled modules are checked identically — a module
// gets no more reach than an agent.
//
// This is NOT the 1.x rules engine coming back. That gated every call as
// (agent → destination : permission): a three-axis matrix, per agent, that nobody
// maintained. Here there is one axis — the site — and the same answer applies to every
// authorized caller, so the whole policy fits on one screen and reads in order.
//
// Deny-by-default: a fresh install's default line is all-off and grants nothing.

import { state, save } from './state.mjs';

// `write` is deliberately NOT a separate capability. It looks like the milder half of
// control — typing versus clicking — but browser_fill accepts `enter`, which calls
// form.requestSubmit(): filling a form IS committing it. A write/control split would let
// an agent submit a purchase while the user believed they had withheld the ability to
// act, which is a distinction that reads as safety without being any. The line that
// holds is look versus touch: read versus control.

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

// --- The model -----------------------------------------------------------------
// An ORDERED rule list, evaluated top to bottom, with the last row being the default.
// This replaces the earlier "default + flat overrides" because the two questions people
// actually ask are ordered ones: "what does THIS site get" and "what does everything
// else get". A rule list answers both in reading order.
//
//   rules[]   { id, pattern, caps: { read|control|record|annotate: true|false|null }, storage: 'tmp'|'perm'|null }
//   default   { read, control, record, annotate, storage }   — the bottom line; binary, always decides
//   tabs{}    origin -> { read?, control?, record?, annotate?, storage? }  — per-tab, only where no rule decided
//
// null in a rule means N/A: that rule expresses no opinion about that capability, so
// evaluation carries on. A rule that DOES decide a capability LOCKS it — the per-tab
// switch for it is shown set and disabled, because a control you can move that doesn't
// change the answer is worse than one you cannot.
//
// The default row deliberately does NOT lock: it is what a tab gets when nothing else
// said, and the user can still override any individual tab.

export const CAPS = ['read', 'control', 'record', 'annotate'];
export const CAPABILITIES = CAPS; // legacy name, still imported by module manifests

const emptyCaps = () => ({ read: null, control: null, record: null, annotate: null });

export function tabAccess() {
  let t = state.tabAccess;
  if (!t || typeof t !== 'object') t = state.tabAccess = {};

  // Migrate 2.0.x shapes. `mode` was 2.0.0–2.0.5; `default:'on'|'off'` + flat `origins`
  // was 2.0.6. Both carried a single yes/no per site, which becomes read+control+record+
  // annotate all set the same way — the capability split is new, so anything already
  // allowed stays allowed rather than quietly losing abilities on upgrade.
  if (t.mode || typeof t.default === 'string' || Array.isArray(t.origins)) {
    const allowAll = t.mode === 'all' || t.default === 'on';
    const list = t.mode
      ? (Array.isArray(t.origins) ? t.origins.map((p) => [p, true]) : [])
      : Object.entries(t.origins && typeof t.origins === 'object' ? t.origins : {});
    const migrated = {
      rules: list.map(([pattern, on], i) => ({
        id: 'r' + (i + 1), pattern: String(pattern),
        caps: { read: !!on, control: !!on, record: !!on, annotate: !!on },
        storage: null,
      })),
      default: { read: allowAll, control: allowAll, record: allowAll, annotate: allowAll, storage: 'tmp' },
      tabs: {},
    };
    t = state.tabAccess = migrated;
    save();
  }

  if (!Array.isArray(t.rules)) t.rules = [];
  if (!t.default || typeof t.default !== 'object') t.default = { read: false, control: false, record: false, annotate: false, storage: 'tmp' };
  for (const c of CAPS) t.default[c] = !!t.default[c];
  if (t.default.storage !== 'perm') t.default.storage = 'tmp';
  if (!t.tabs || typeof t.tabs !== 'object' || Array.isArray(t.tabs)) t.tabs = {};
  return t;
}

// --- Resolution ----------------------------------------------------------------
// Returns, for one URL, every capability's value AND where it came from, because the UI
// has to render "set by a rule, don't touch" differently from "you chose this".
// `source`: 'rule' (locked) | 'tab' (your per-tab choice) | 'default'.
export function resolve(url) {
  const t = tabAccess();
  const origin = originOf(url);
  const tab = (origin && t.tabs[origin]) || {};
  const out = {};

  for (const c of CAPS) {
    let val = null, source = null, rule = null;
    for (const r of t.rules) {
      if (!matchPattern(r.pattern, url)) continue;
      const v = r.caps ? r.caps[c] : null;
      if (v === true || v === false) { val = v; source = 'rule'; rule = r; break; }
    }
    if (source === null) {
      if (typeof tab[c] === 'boolean') { val = tab[c]; source = 'tab'; }
      else { val = t.default[c]; source = 'default'; }
    }
    out[c] = { value: val, source, rule: rule ? rule.pattern : null, locked: source === 'rule' };
  }

  // READ IS THE MASTER. Without it an agent cannot see what it is acting on, and every
  // other capability either depends on reading (control, annotate) or degrades to
  // something not worth having (record without read is screenshots alone). So read=false
  // forces the rest off — enforced HERE, not merely greyed in the UI, so the guarantee
  // holds for every caller.
  if (!out.read.value) {
    for (const c of CAPS) {
      if (c === 'read') continue;
      if (out[c].value) out[c] = { ...out[c], value: false, forcedByRead: true };
    }
  }

  // Storage follows the same order, but it is a qualifier on recordings, not a permission.
  let storage = null, storageSource = null;
  for (const r of t.rules) {
    if (!matchPattern(r.pattern, url)) continue;
    if (r.storage === 'tmp' || r.storage === 'perm') { storage = r.storage; storageSource = 'rule'; break; }
  }
  if (!storage) {
    if (tab.storage === 'tmp' || tab.storage === 'perm') { storage = tab.storage; storageSource = 'tab'; }
    else { storage = t.default.storage; storageSource = 'default'; }
  }
  out.storage = { value: storage, source: storageSource, locked: storageSource === 'rule' };
  return out;
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

// --- The check -----------------------------------------------------------------
// `url` may be null for calls that target no particular tab (tabs.list, monitor.list…).
// Those pass whenever the capability is reachable ANYWHERE; their results are filtered
// by the caller so a tab you cannot use is never revealed.
export function urlAllowed(url, capability = 'read') {
  const cap = CAPS.includes(capability) ? capability : 'read';
  if (!url) {
    return anyAllowed(cap)
      ? { allow: true, reason: 'no specific tab' }
      : { allow: false, reason: `no site grants "${cap}" — turn it on in the control panel` };
  }
  const r = resolve(url)[cap];
  if (r.value) return { allow: true, reason: r.source === 'rule' ? `rule ${r.rule}` : r.source };
  if (r.forcedByRead) return { allow: false, reason: `${safeHost(url)} has read turned off, so "${cap}" is off too` };
  return { allow: false, reason: `${safeHost(url)} does not allow "${cap}"` };
}

// Could this capability apply to anything at all? Used for untargeted calls.
function anyAllowed(cap) {
  const t = tabAccess();
  if (t.default.read && (cap === 'read' || t.default[cap])) return true;
  for (const r of t.rules) if (r.caps && r.caps[cap] === true) return true;
  for (const o of Object.values(t.tabs)) if (o && o[cap] === true) return true;
  return false;
}

const safeHost = (u) => { try { return new URL(u).host; } catch { return String(u || '').slice(0, 60); } };

// --- Editing -------------------------------------------------------------------
let _seq = 0;
const newId = () => 'r' + Date.now().toString(36) + (++_seq).toString(36);

export function addRule(pattern) {
  const t = tabAccess();
  const p = String(pattern || '').trim();
  if (!p) return { ok: false, error: 'pattern required' };
  if (t.rules.length >= 200) return { ok: false, error: 'too many rules' };
  t.rules.push({ id: newId(), pattern: p, caps: emptyCaps(), storage: null });
  save();
  return { ok: true };
}

export function removeRule(id) {
  const t = tabAccess();
  t.rules = t.rules.filter((r) => r.id !== id);
  save();
  return { ok: true };
}

// Order matters (first decision wins), so it has to be editable.
export function moveRule(id, dir) {
  const t = tabAccess();
  const i = t.rules.findIndex((r) => r.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= t.rules.length) return { ok: false, error: 'cannot move' };
  const [x] = t.rules.splice(i, 1);
  t.rules.splice(j, 0, x);
  save();
  return { ok: true };
}

// Cycle a rule's capability through On -> Off -> N/A, which is the order people reach
// for: you set it, you change your mind, you stop caring.
export function cycleRuleCap(id, cap) {
  const t = tabAccess();
  const r = t.rules.find((x) => x.id === id);
  if (!r || !CAPS.includes(cap)) return { ok: false, error: 'unknown rule or capability' };
  r.caps = r.caps || emptyCaps();
  r.caps[cap] = r.caps[cap] === true ? false : r.caps[cap] === false ? null : true;
  // Read off forces the rest off, but their stored values are KEPT. Clearing them looked
  // tidier until you turn read back on and discover your other choices are gone — the
  // same way flipping the default used to wipe per-site decisions. The resolver enforces
  // the consequence; the state remembers the intent.
  save();
  return { ok: true };
}

export function cycleRuleStorage(id) {
  const t = tabAccess();
  const r = t.rules.find((x) => x.id === id);
  if (!r) return { ok: false, error: 'unknown rule' };
  r.storage = r.storage === 'tmp' ? 'perm' : r.storage === 'perm' ? null : 'tmp';
  save();
  return { ok: true };
}

export function setDefaultCap(cap, on) {
  const t = tabAccess();
  if (cap === 'storage') { t.default.storage = on === 'perm' ? 'perm' : 'tmp'; save(); return { ok: true }; }
  if (!CAPS.includes(cap)) return { ok: false, error: 'unknown capability' };
  t.default[cap] = !!on; // read-off is enforced by resolve(), not by wiping the others
  save();
  return { ok: true };
}

// Per-tab choice. Only meaningful where no rule decided the capability; the UI disables
// the control otherwise, and the resolver ignores it either way.
export function setTabCap(origin, cap, value) {
  const t = tabAccess();
  const o = String(origin || '').trim();
  if (!o) return { ok: false, error: 'origin required' };
  const rec = t.tabs[o] || (t.tabs[o] = {});
  if (value === null) delete rec[cap];
  else if (cap === 'storage') rec.storage = value === 'perm' ? 'perm' : 'tmp';
  else rec[cap] = !!value; // read-off is enforced by resolve(), not by wiping the others
  if (!Object.keys(rec).length) delete t.tabs[o];
  save();
  return { ok: true };
}

export function toggleTabCap(origin, cap) {
  const cur = resolve(origin)[cap];
  if (cur.locked) return { ok: false, error: 'set by a rule' };
  if (cap === 'storage') return setTabCap(origin, 'storage', cur.value === 'perm' ? 'tmp' : 'perm');
  return setTabCap(origin, cap, !cur.value);
}

// Bulk, for the column headers. Skips anything a rule has locked.
export function setManyTabCaps(origins, cap, value) {
  for (const o of origins) {
    if (resolve(o)[cap].locked) continue;
    setTabCap(o, cap, value);
  }
  return { ok: true };
}

// --- Recording storage class -------------------------------------------------
// `tmp` ($TMPDIR, cleared by the OS) or `perm` (browser-bridge/recordings, kept). It is
// not a permission — it only says where a recording goes — but it resolves through the
// same rule list so there is exactly one precedence order on the page.

// Where THIS url's recording lands. Rule > per-tab > default, same as the capabilities.
export function storageFor(url) {
  try { return resolve(url).storage.value; } catch { return tabAccess().default.storage; }
}

export function setStorageDefault(value) { return setDefaultCap('storage', value === 'perm' ? 'perm' : 'tmp'); }
export function toggleStorage(origin) { return toggleTabCap(origin, 'storage'); }
export function setManyStorage(origins, value) { return setManyTabCaps(origins, 'storage', value === 'perm' ? 'perm' : 'tmp'); }

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
