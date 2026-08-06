// state.mjs — durable, loopback-only store for OAuth clients/grants/tokens and
// the bridge↔extension pairing key. Kept in a 0600 JSON file so grants and the
// pairing survive restarts (the whole point of "permanent, OAuth-style" auth).

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// State lives beside the bridge source (0600). It is gitignored, so both update
// channels preserve it: the git channel fast-forwards tracked files only, and the
// zip channel swaps tracked files in place — neither touches this file.
// EMBEDDED MODE ONLY: a host application running the bridge as an internal
// component may relocate state via BRIDGE_STATE_FILE (its bundle dir is replaced
// wholesale on update). Ignored in standalone mode — a normal install's state
// location is not configurable.
const FILE = (process.env.BRIDGE_EMBEDDED === '1' && process.env.BRIDGE_STATE_FILE)
  || join(dirname(fileURLToPath(import.meta.url)), '.bridge-state.json');

export const state = {
  clients: {},   // client_id -> { client_id, client_name, redirect_uris[], created }
  grants: {},    // client_id -> { client_id, name, resource, created, lastUsed }  (authorized agents)
  tokens: {},    // access_token -> { client_id, resource, exp }
  refresh: {},   // refresh_token -> { client_id, resource }
  pairing: null, // legacy single bridge↔extension pairing (migrated into `browsers`)
  browsers: {},  // browserId -> { id, name, key(hex), created, lastSeen } — linked browsers
  activeBrowser: null, // browserId that currently receives relayed commands
  autoUpdate: false, // opt-in: auto fast-forward the git clone from origin + restart

  // Which tabs may be touched at all — the one access control in 2.0, replacing the
  // rules engine. Deny-by-default: a fresh install grants nothing.
  tabAccess: { mode: 'none', origins: [] }, // mode: 'all' | 'selected' | 'none'
  recording: { default: 'tmp', byOrigin: {} }, // where a tab's recording is saved

  // Modules — scheduled automations, not an agent tool surface.
  modulesEnabled: [],  // [moduleId] — which modules are active
  moduleOwners: {},    // moduleId -> { client_id, name, since } — who may update it unattended
  modulesSeen: [],     // [moduleId] — modules discovered at least once; gates one-time autoEnable so a manual disable sticks
  moduleRuns: {},      // moduleId -> { lastRun, lastError, lastFireKey, running } — scheduler bookkeeping
  moduleStore: {},     // moduleId -> arbitrary JSON a module persists via ctx.store
};

// Keys retired in 2.0. Dropped on load rather than migrated: they described a rules
// engine that no longer exists, so carrying them forward would only leave a stale
// matrix in the state file that nothing reads and nobody can edit.
const RETIRED = ['rules', 'destinations', 'artifacts', 'sources'];

export function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'));
      for (const k of ['clients', 'grants', 'tokens', 'refresh', 'browsers', 'moduleOwners', 'moduleRuns', 'moduleStore']) if (d[k]) state[k] = d[k];
      for (const k of ['modulesEnabled', 'modulesSeen']) if (Array.isArray(d[k])) state[k] = d[k];
      if (d.tabAccess && typeof d.tabAccess === 'object') state.tabAccess = d.tabAccess;
      if (d.recording && typeof d.recording === 'object') state.recording = d.recording;
      if ('pairing' in d) state.pairing = d.pairing;
      if ('activeBrowser' in d) state.activeBrowser = d.activeBrowser;
      if ('autoUpdate' in d) state.autoUpdate = !!d.autoUpdate;
      // A 1.x file that granted every tab through the old research destination shouldn't
      // silently become deny-all on upgrade — carry that one decision across, since it
      // was an explicit user choice and losing it looks like the bridge broke.
      if (!d.tabAccess && d.artifacts) {
        const contents = Object.values(d.artifacts)
          .flatMap((a) => Object.values((a && a.destinations) || {}))
          .flatMap((x) => (x && Array.isArray(x.contents) ? x.contents : []));
        if (contents.length) {
          state.tabAccess = contents.includes('*')
            ? { mode: 'all', origins: [] }
            : { mode: 'selected', origins: [...new Set(contents)] };
        }
      }
      if (RETIRED.some((k) => k in d)) queueMicrotask(save); // rewrite the file without them
    }
  } catch { /* start empty */ }
  return state;
}

export function save() {
  try {
    writeFileSync(FILE, JSON.stringify(state, null, 2));
    chmodSync(FILE, 0o600);
  } catch { /* best effort */ }
}

load();
