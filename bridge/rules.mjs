// rules.mjs — the bridge's policy engine. Every core browser tool call is
// evaluated as (Source → Destination : Permission), deny-by-default.
//
//   Source      = the acting agent's OAuth client_name ('Any Agent' = wildcard)
//   Permission  = a fixed verb (read|write|control|record) derived from the tool
//   Destination = a named set of origin/URL patterns the action must fall within
//
// Rules live in `state.rules`; destination pattern-sets are registered by the
// module loader (static module patterns ∪ user-curated dynamic contents).

import { state } from './state.mjs';

// Fixed permission verbs → the core browser tools they cover.
// `annotate` = draw the bridge's own visual overlay on a tab (badges/dim/strike).
// Deliberately its own verb so a user can let an agent mark up what they're looking
// at WITHOUT granting `control` (which includes browser_eval and can do anything).
// The annotate tools never return page-derived content — see mcp.mjs — so this verb
// cannot become a content-read path.
export const VERB_TOOLS = {
  read: ['browser_tabs_list', 'browser_focused_tab', 'browser_read', 'browser_screenshot'],
  write: ['browser_navigate', 'browser_fill'],
  control: ['browser_new_tab', 'browser_close_tab', 'browser_activate_tab', 'browser_eval', 'browser_click', 'browser_scroll'],
  record: ['browser_monitor_start', 'browser_monitor_stop', 'browser_monitor_list'],
  annotate: ['browser_annotate', 'browser_annotate_clear', 'browser_annotate_list'],
};
export const PERMISSIONS = Object.keys(VERB_TOOLS);
const TOOL_VERB = {};
for (const [verb, tools] of Object.entries(VERB_TOOLS)) for (const t of tools) TOOL_VERB[t] = verb;

// Tools that act across/without a single URL target — gated by the verb alone.
// browser_focused_tab is non-targeted for the same reason as browser_tabs_list: the
// call itself has no URL, and its RESULT is filtered by read permission in mcp.mjs.
const NON_TARGETED = new Set(['browser_tabs_list', 'browser_focused_tab', 'browser_monitor_list', 'browser_monitor_stop']);

export function toolVerb(toolName) { return TOOL_VERB[toolName] || null; }

// --- Destination registry ----------------------------------------------------
// Module destinations live in this in-memory Map (registered on enable). User-
// created destinations live in state.destinations (persisted) and are always
// available regardless of any module.
const destinations = new Map(); // destId -> { name, moduleId, patterns[] }
export function setDestination(id, { name, moduleId, patterns }) {
  destinations.set(id, { name: name || id, moduleId: moduleId || null, patterns: patterns || [] });
}
export function removeDestinationsByModule(moduleId) {
  for (const [id, d] of destinations) if (d.moduleId === moduleId) destinations.delete(id);
}
// Resolve a destination id to its patterns (module first, then user). null = unknown.
function destPatterns(id) {
  const d = destinations.get(id);
  if (d) return d.patterns || [];
  const u = (state.destinations || []).find((x) => x.id === id);
  return u ? (u.patterns || []) : null;
}
export function getDestinations() {
  const mod = [...destinations.entries()].map(([id, d]) => ({ id, ...d, user: false }));
  const usr = (state.destinations || []).map((d) => ({ id: d.id, name: d.name, moduleId: null, patterns: d.patterns || [], user: true }));
  return [...mod, ...usr];
}

// --- Pattern matching --------------------------------------------------------
// Escape regex specials INCLUDING '*' (so it becomes \*), then turn \* into .*
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
const globRe = (p) => new RegExp('^' + escapeRe(p).replace(/\\\*/g, '.*') + '$', 'i');

// Does `pattern` cover `url`? Supports exact origin, host wildcard (*.okta.com),
// URL prefix (https://acme.okta.com/app/*), bare host, and '*' (everything).
export function matchPattern(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const isHttp = u.protocol === 'http:' || u.protocol === 'https:';
  if (!isHttp) return pattern === url || pattern === u.origin; // non-http: explicit only
  const hasScheme = /^https?:\/\//i.test(pattern);
  const rx = globRe(pattern);
  if (hasScheme) return rx.test(u.origin) || rx.test(u.href);
  // Bare host / '*' pattern → match against host.
  return rx.test(u.host) || rx.test(u.hostname);
}

// --- Evaluation --------------------------------------------------------------
// Rules are evaluated TOP-DOWN, first match wins. Each rule carries an action
// (allow | deny); the first rule whose (source, permission, destination) all
// match decides. Nothing matches → deny-by-default. This lets a deny (or allow)
// rule placed at the top of the list supersede everything below it.
// Only applies to core browser tools (TOOL_VERB); module tools are handled by
// the caller (allowed when the module is on).
export function evaluate(sourceName, targetUrl, toolName) {
  // Third arg is a core tool name OR a bare verb (module tools declare one of the
  // closed set read|write|control|record|annotate — never a made-up verb, so rules
  // stay meaningful to users who have never heard of the module).
  const verb = TOOL_VERB[toolName] || (PERMISSIONS.includes(toolName) ? toolName : null);
  if (!verb) return { allow: false, reason: `unknown tool '${toolName}'` };
  const nonTargeted = NON_TARGETED.has(toolName) || !targetUrl;
  for (const r of (state.rules || [])) {
    if (r.enabled === false) continue;
    if (!(r.source === 'Any Agent' || r.source === sourceName)) continue;
    if (!(r.permissions || []).includes(verb)) continue;
    let destMatch;
    if (nonTargeted) {
      destMatch = true; // no URL to test — source + permission is enough
    } else {
      const patterns = destPatterns(r.destination);
      if (patterns == null) continue; // destination unknown (e.g. module disabled) → can't match
      destMatch = patterns.some((p) => matchPattern(p, targetUrl));
    }
    if (!destMatch) continue;
    const deny = r.action === 'deny';
    return { allow: !deny, reason: `rule '${r.id}' (${deny ? 'deny' : 'allow'})` };
  }
  return { allow: false, reason: nonTargeted ? `no rule grants '${verb}' to '${sourceName}'` : `no rule matches ${targetUrl} for '${verb}'` };
}

// --- tabId → URL resolution (small cache over relayed tabs.list) -------------
let _relay = null;
const tabCache = new Map(); // tabId -> { url, ts }
const TAB_TTL_MS = 2500;

export function configureRules({ relayCommand }) { _relay = relayCommand; }

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
