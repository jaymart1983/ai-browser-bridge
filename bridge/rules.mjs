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
export const VERB_TOOLS = {
  read: ['browser_tabs_list', 'browser_read', 'browser_screenshot'],
  write: ['browser_navigate'],
  control: ['browser_new_tab', 'browser_close_tab', 'browser_activate_tab', 'browser_eval'],
  record: ['browser_monitor_start', 'browser_monitor_stop', 'browser_monitor_list'],
};
export const PERMISSIONS = Object.keys(VERB_TOOLS);
const TOOL_VERB = {};
for (const [verb, tools] of Object.entries(VERB_TOOLS)) for (const t of tools) TOOL_VERB[t] = verb;

// Tools that act across/without a single URL target — gated by the verb alone.
const NON_TARGETED = new Set(['browser_tabs_list', 'browser_monitor_list', 'browser_monitor_stop']);

export function toolVerb(toolName) { return TOOL_VERB[toolName] || null; }

// --- Destination registry (maintained by the module loader) ------------------
const destinations = new Map(); // destId -> { name, moduleId, patterns[] }
export function setDestination(id, { name, moduleId, patterns }) {
  destinations.set(id, { name: name || id, moduleId: moduleId || null, patterns: patterns || [] });
}
export function removeDestinationsByModule(moduleId) {
  for (const [id, d] of destinations) if (d.moduleId === moduleId) destinations.delete(id);
}
export function getDestinations() {
  return [...destinations.entries()].map(([id, d]) => ({ id, ...d }));
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
// Returns { allow, reason }. Only applies to core browser tools (TOOL_VERB);
// module-provided tools are handled by the caller (allowed when the module is on).
export function evaluate(sourceName, targetUrl, toolName) {
  const verb = TOOL_VERB[toolName];
  if (!verb) return { allow: false, reason: `unknown tool '${toolName}'` };
  const candidates = (state.rules || []).filter(
    (r) => r.enabled !== false && (r.source === 'Any Agent' || r.source === sourceName) && (r.permissions || []).includes(verb),
  );
  if (!candidates.length) return { allow: false, reason: `no rule grants '${verb}' to '${sourceName}'` };
  if (NON_TARGETED.has(toolName) || !targetUrl) return { allow: true, reason: `${verb} granted` };
  for (const r of candidates) {
    const dest = destinations.get(r.destination);
    if (!dest) continue;
    for (const p of dest.patterns) if (matchPattern(p, targetUrl)) return { allow: true, reason: `rule '${r.id}'` };
  }
  return { allow: false, reason: `no allowed destination matches ${targetUrl}` };
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
