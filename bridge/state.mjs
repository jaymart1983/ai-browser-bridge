// state.mjs — durable, loopback-only store for OAuth clients/grants/tokens and
// the bridge↔extension pairing key. Kept in a 0600 JSON file so grants and the
// pairing survive restarts (the whole point of "permanent, OAuth-style" auth).

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '.bridge-state.json');

export const state = {
  clients: {},   // client_id -> { client_id, client_name, redirect_uris[], created }
  grants: {},    // client_id -> { client_id, name, resource, created, lastUsed }  (authorized agents)
  tokens: {},    // access_token -> { client_id, resource, exp }
  refresh: {},   // refresh_token -> { client_id, resource }
  pairing: null, // legacy single bridge↔extension pairing (migrated into `browsers`)
  browsers: {},  // browserId -> { id, name, key(hex), created, lastSeen } — linked browsers
  activeBrowser: null, // browserId that currently receives relayed commands

  // Capability platform (the rule engine + modules).
  modulesEnabled: [],  // [moduleId] — which capability modules are active
  rules: [],           // ordered, top-down first-match: [{ id, action:'allow'|'deny', source, destination, permissions[], enabled, moduleId? }]
  destinations: [],    // user-created destination artifacts: [{ id, name, patterns[] }]
  artifacts: {},       // moduleId -> { destinations: { destId: { patterns[], contents[] } }, sources: {…} }
};

export function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'));
      for (const k of ['clients', 'grants', 'tokens', 'refresh', 'artifacts', 'browsers']) if (d[k]) state[k] = d[k];
      for (const k of ['modulesEnabled', 'rules', 'destinations']) if (Array.isArray(d[k])) state[k] = d[k];
      if ('pairing' in d) state.pairing = d.pairing;
      if ('activeBrowser' in d) state.activeBrowser = d.activeBrowser;
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
