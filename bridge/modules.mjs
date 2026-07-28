// modules.mjs — capability-module loader. Discovers bridge/modules/*.mjs,
// validates their manifests, and manages enable/disable. Enabling a module
// registers its destinations + seeds its base rules; disabling unregisters the
// destinations (so its rules can no longer match) while leaving user-authored
// rules intact for re-enable. Deny-by-default: nothing is live until enabled.

import { readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
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
  // Re-apply persisted enabled state (register destinations for enabled modules).
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    if (mod) registerDestinations(mod);
  }
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

// Write a new/updated module file and reload. `code` is arbitrary JS that will
// be dynamically imported (executed in the bridge). Loopback-only + user-driven.
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

export function setEnabled(id, enabled) {
  const mod = registry.get(id);
  if (!mod) return { ok: false, error: 'no such module' };
  const cur = isEnabled(id);
  if (enabled && !cur) {
    state.modulesEnabled.push(id);
    registerDestinations(mod);
    for (const r of mod.baseRules || []) {
      if (!state.rules.find((x) => x.id === r.id)) {
        state.rules.push({ ...r, moduleId: mod.id, enabled: r.enabled !== false });
      }
    }
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
export function allNavLinks() {
  const out = [];
  for (const id of state.modulesEnabled) {
    const mod = registry.get(id);
    for (const l of (mod && mod.navLinks) || []) out.push({ ...l, moduleId: id });
  }
  return out;
}
