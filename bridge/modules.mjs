// modules.mjs — capability-module loader. Discovers bridge/modules/*.mjs,
// validates their manifests, and manages enable/disable. Enabling a module
// registers its destinations + seeds its base rules; disabling unregisters the
// destinations (so its rules can no longer match) while leaving user-authored
// rules intact for re-enable. Deny-by-default: nothing is live until enabled.

import { readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { state, save } from './state.mjs';
import { setDestination, removeDestinationsByModule, getDestinations } from './rules.mjs';

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'modules');
const registry = new Map(); // id -> manifest
const files = new Map();    // id -> absolute .mjs path (for delete)
let _ctx = null;

export function configureModules(ctx) { _ctx = ctx; }
export function getModuleCtx() { return _ctx; }

function validate(mod) {
  return !!(mod && typeof mod.id === 'string' && typeof mod.name === 'string');
}

export async function loadModules() {
  registry.clear(); files.clear();
  if (existsSync(MODULES_DIR)) {
    for (const f of readdirSync(MODULES_DIR)) {
      if (!f.endsWith('.mjs')) continue;
      const abs = join(MODULES_DIR, f);
      try {
        // Cache-bust so re-uploaded/edited modules load fresh.
        const mod = (await import(pathToFileURL(abs).href + '?v=' + Date.now())).default;
        if (validate(mod)) { registry.set(mod.id, mod); files.set(mod.id, abs); }
        else console.error('[modules] invalid manifest:', f);
      } catch (e) { console.error('[modules] failed to load', f, e && e.message); }
    }
  }
  // Re-apply persisted enabled state (register destinations for enabled modules) and
  // seed any base rule the module has ADDED since it was enabled. Without this, a
  // module update that introduces a new rule (e.g. to grant a newly-added permission
  // verb) would never take effect on an existing install, because baseRules used to be
  // seeded only on the disabled→enabled transition. Only rules whose id is absent are
  // added, so a rule the user edited or deleted is never resurrected or overwritten.
  let rulesAdded = 0;
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    if (!mod) continue;
    registerDestinations(mod);
    rulesAdded += seedBaseRules(mod);
  }
  if (rulesAdded) { console.log(`[modules] seeded ${rulesAdded} new base rule(s) from module updates`); save(); }
  // One-time auto-enable: a module declares `autoEnable: true` in its own manifest to
  // go live on first install without a manual toggle. Purely module-driven — the bridge
  // holds no module names. Gated on `modulesSeen` so it fires ONCE per module: if the
  // user later disables it, it stays disabled (we never re-enable a seen module).
  state.modulesSeen = state.modulesSeen || [];
  let seenChanged = false;
  for (const [id, mod] of registry) {
    if (state.modulesSeen.includes(id)) continue;
    state.modulesSeen.push(id); seenChanged = true;
    if (mod.autoEnable && !isEnabled(id)) setEnabled(id, true);
  }
  if (seenChanged) save();
}

// --- Module-install approval queue ------------------------------------------
// Uploading a module = arbitrary JS executed inside the bridge. The web UI is
// loopback-only but effectively unauthenticated, so an install must be approved
// by a human in the EXTENSION (signed with the pairing key) before any code is
// written or executed — the same gate OAuth consent uses. Requests are held in
// memory only, capped, and expire unapproved.
const pendingInstalls = new Map(); // reqId -> { reqId, name, code, created }
const INSTALL_TTL_MS = 10 * 60 * 1000;
let notifyApprovals = null;
export function configureModuleApprovals(o) { notifyApprovals = (o && o.notify) || null; }
function pingApprovals() { if (notifyApprovals) { try { notifyApprovals(pendingInstalls.size); } catch { /* best effort */ } } }
function pruneInstalls() {
  const cutoff = Date.now() - INSTALL_TTL_MS;
  for (const [k, p] of pendingInstalls) if (p.created < cutoff) pendingInstalls.delete(k);
}
export function requestModuleInstall(name, code) {
  pruneInstalls();
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'code required' };
  if (code.length > 1_000_000) return { ok: false, error: 'module too large (1 MB max)' };
  if (pendingInstalls.size >= 10) return { ok: false, error: 'too many pending installs — approve or deny them first' };
  const reqId = 'mi_' + randomBytes(9).toString('base64url');
  pendingInstalls.set(reqId, { reqId, name: String(name || 'module').slice(0, 80), code, created: Date.now() });
  pingApprovals();
  return { ok: true, reqId };
}
export function listModuleInstalls() {
  pruneInstalls();
  return [...pendingInstalls.values()].map((p) => ({ reqId: p.reqId, name: p.name, bytes: p.code.length, created: p.created }));
}
// Caller MUST have verified the decision signature (pairing.verifyDecision) first.
export async function decideModuleInstall(reqId, approve) {
  const p = pendingInstalls.get(reqId);
  if (!p) return { ok: false, error: 'no such request (expired?)' };
  pendingInstalls.delete(reqId);
  pingApprovals();
  if (!approve) return { ok: true, installed: false };
  const r = await uploadModule(p.name, p.code);
  return { ok: true, installed: true, ...r };
}

// Write a new/updated module file and reload. `code` is arbitrary JS that will
// be dynamically imported (executed in the bridge). Reached ONLY via an approved
// install request (decideModuleInstall) — never directly from an HTTP route.
export async function uploadModule(name, code) {
  let base = String(name || 'module').replace(/\.mjs$/i, '').replace(/[^a-z0-9_-]/gi, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'module';
  mkdirSync(MODULES_DIR, { recursive: true });
  writeFileSync(join(MODULES_DIR, base + '.mjs'), String(code || ''));
  const before = new Set(registry.keys());
  await loadModules();
  const added = [...registry.keys()].filter((k) => !before.has(k));
  return { ok: true, file: base + '.mjs', added };
}

// Delete a module: disable, purge its rules/artifacts/destinations, remove file.
export async function deleteModule(id) {
  if (!registry.has(id)) return { ok: false, error: 'no such module' };
  if (isEnabled(id)) setEnabled(id, false);
  state.rules = (state.rules || []).filter((r) => r.moduleId !== id);
  delete state.artifacts[id];
  state.modulesEnabled = state.modulesEnabled.filter((x) => x !== id);
  removeDestinationsByModule(id);
  save();
  const file = files.get(id);
  if (file) { try { unlinkSync(file); } catch {} }
  registry.delete(id); files.delete(id);
  return { ok: true };
}

export function isEnabled(id) { return state.modulesEnabled.includes(id); }
export function getModule(id) { return registry.get(id); }
export function listModules() {
  return [...registry.values()].map((m) => ({ id: m.id, name: m.name, description: m.description || '', enabled: isEnabled(m.id) }));
}

// Effective destination pattern-set = module-static patterns ∪ user-curated contents.
function registerDestinations(mod) {
  const art = (state.artifacts[mod.id] && state.artifacts[mod.id].destinations) || {};
  for (const d of (mod.artifacts && mod.artifacts.destinations) || []) {
    const contents = (art[d.id] && art[d.id].contents) || [];
    setDestination(d.id, { name: d.name, moduleId: mod.id, patterns: [...(d.patterns || []), ...contents] });
  }
}

// Add any of the module's baseRules that aren't in state yet. Additive only — an
// existing rule id is left exactly as the user has it. Returns how many were added.
function seedBaseRules(mod) {
  let added = 0;
  for (const r of mod.baseRules || []) {
    if (!state.rules.find((x) => x.id === r.id)) {
      state.rules.push({ ...r, moduleId: mod.id, enabled: r.enabled !== false });
      added++;
    }
  }
  return added;
}

export function setEnabled(id, enabled) {
  const mod = registry.get(id);
  if (!mod) return { ok: false, error: 'no such module' };
  const cur = isEnabled(id);
  if (enabled && !cur) {
    state.modulesEnabled.push(id);
    registerDestinations(mod);
    seedBaseRules(mod);
    if (mod.onEnable && _ctx) { try { mod.onEnable(_ctx); } catch (e) { console.error('[modules] onEnable', e && e.message); } }
  } else if (!enabled && cur) {
    state.modulesEnabled = state.modulesEnabled.filter((x) => x !== id);
    removeDestinationsByModule(mod.id); // rules stay in state but can no longer match
    if (mod.onDisable && _ctx) { try { mod.onDisable(_ctx); } catch (e) { console.error('[modules] onDisable', e && e.message); } }
  }
  save();
  return { ok: true };
}

// Re-register a module's destinations after its dynamic contents change
// (populate / user curation writes into state.artifacts, then calls this).
export function refreshModuleDestinations(id) {
  const mod = registry.get(id);
  if (mod && isEnabled(id)) registerDestinations(mod);
}

// Set the curated contents for a dynamic destination, persist, and re-register.
export function setDestinationContents(moduleId, destId, contents) {
  state.artifacts[moduleId] = state.artifacts[moduleId] || { destinations: {} };
  state.artifacts[moduleId].destinations = state.artifacts[moduleId].destinations || {};
  state.artifacts[moduleId].destinations[destId] = { contents: Array.isArray(contents) ? contents : [] };
  save();
  refreshModuleDestinations(moduleId);
  return { ok: true };
}

// --- Aggregators for the MCP surface + rule-builder UI -----------------------
export function allModuleTools() {
  const tools = {};
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    if (mod && mod.tools) for (const [name, t] of Object.entries(mod.tools)) tools[name] = { ...t, moduleId: id };
  }
  return tools;
}
export function allSources() {
  const out = [{ id: 'any', name: 'Any Agent', kind: 'static' }];
  const seen = new Set(['Any Agent']);
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    for (const s of (mod && mod.artifacts && mod.artifacts.sources) || []) {
      if (!seen.has(s.name)) { seen.add(s.name); out.push({ ...s, moduleId: id }); }
    }
  }
  return out;
}
export function allDestinations() { return getDestinations(); }

// Extension capabilities in use by ENABLED modules. Core MCP tools that surface an
// extension capability (annotate, record, …) are only advertised/callable while some
// enabled module declares it via `capabilities: ['annotate']` in its manifest — the
// module is also what seeds the rule objects that allow the verb, so without one the
// tool could never pass policy anyway. Declaring the capability = owning its rules.
export function activeCapabilities() {
  const out = new Set();
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    for (const c of (mod && mod.capabilities) || []) out.add(String(c));
  }
  return out;
}

// Server-level MCP `instructions` (returned on initialize) — how an agent should use
// this bridge. A module contributes its own section via an `instructions` string (or a
// function returning one), so guidance ships WITH the capability instead of relying on
// the user to paste a prompt. Only enabled modules contribute.
export function allInstructions() {
  const out = [];
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    if (!mod || !mod.instructions) continue;
    let text = '';
    try { text = typeof mod.instructions === 'function' ? mod.instructions(_ctx) : String(mod.instructions); }
    catch { continue; }
    if (text && text.trim()) out.push(`## ${mod.name}\n\n${text.trim()}`);
  }
  return out;
}

// --- Focused-tab actions -----------------------------------------------------
// A module declares `tabActions: [{ id, uses?, labels:{on,off}, match? }]` to have
// the extension popup surface a per-tab action (e.g. Deep Research "Record this
// tab"). `uses` names a built-in EXTENSION CAPABILITY the bridge knows how to drive
// (currently 'recording'); a module can instead implement `onTabAction(id, {tabId,
// url}, ctx)` for fully custom behavior (the pure-module path). Optional
// `tabActionState(id, {tabId,url}, ctx)` reports on/off for non-recording actions.
// This is ADDITIVE — a module without `tabActions` is unaffected.
function tabActionVisible(ta, url, mod) {
  if (typeof mod.tabActionVisible === 'function') { try { return !!mod.tabActionVisible(ta.id, { url }); } catch { return false; } }
  if (!/^https?:/i.test(url || '')) return false;      // only real web tabs
  const m = ta.match;
  if (!m || m === '*') return true;
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  const pats = Array.isArray(m) ? m : [m];
  return pats.some((p) => p === '*' || p === url || (p.startsWith('*.') && (host === p.slice(2) || host.endsWith(p.slice(1)))));
}

async function recordingTabIds() {
  try { return new Set(((await _ctx.relayCommand('monitor.list')) || []).map((m) => Number(m.tabId))); }
  catch { return new Set(); }
}

export async function listTabActions(url, tabId) {
  if (!_ctx) return [];
  const tid = Number(tabId);
  let rec = null; // lazily fetched only if a recording action is present
  const out = [];
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    for (const ta of (mod && mod.tabActions) || []) {
      if (!tabActionVisible(ta, url, mod)) continue;
      let on = false;
      if (ta.uses === 'recording') { rec = rec || await recordingTabIds(); on = rec.has(tid); }
      else if (typeof mod.tabActionState === 'function') { try { on = !!(await mod.tabActionState(ta.id, { tabId: tid, url }, _ctx)); } catch { on = false; } }
      out.push({ moduleId: id, id: ta.id, label: (on ? ta.labels && ta.labels.on : ta.labels && ta.labels.off) || ta.id, on, uses: ta.uses || null });
    }
  }
  return out;
}

export async function invokeTabAction(moduleId, actionId, tabId, url) {
  if (!_ctx) return { ok: false, error: 'not ready' };
  const mod = registry.get(moduleId);
  if (!mod || !isEnabled(moduleId)) return { ok: false, error: 'module not enabled' };
  const ta = (mod.tabActions || []).find((t) => t.id === actionId);
  if (!ta) return { ok: false, error: 'unknown action' };
  const tid = Number(tabId);
  // Pure-module path: the module handles it however it likes.
  if (typeof mod.onTabAction === 'function') {
    try { const r = await mod.onTabAction(actionId, { tabId: tid, url }, _ctx); return { ok: true, ...(r || {}) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  // Built-in capability: recording toggle.
  if (ta.uses === 'recording') {
    const on = (await recordingTabIds()).has(tid);
    try { await _ctx.relayCommand(on ? 'monitor.stop' : 'monitor.start', { tabId: tid }); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true, on: !on };
  }
  return { ok: false, error: `no handler for capability "${ta.uses || 'none'}"` };
}
// Where the tray's "open dashboard" should land. A module declares `dashboard: '<path>'`
// to claim it — the live view of what the bridge is doing belongs to whichever module is
// actually doing something, not to a page the bridge hardcodes. First enabled module
// that declares one wins; null means fall back to the built-in activity page.
export function moduleDashboardPath() {
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    if (mod && typeof mod.dashboard === 'string' && mod.dashboard.startsWith('/')) return mod.dashboard;
  }
  return null;
}

export function allNavLinks() {
  const out = [];
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    for (const l of (mod && mod.navLinks) || []) out.push({ ...l, moduleId: id });
  }
  return out;
}
