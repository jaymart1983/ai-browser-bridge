// oauth.mjs — a small, spec-aligned OAuth 2.1 Authorization Server for the
// bridge, so any MCP client (Claude Code/Desktop, OpenCode) can obtain a
// permanent, revocable, per-agent grant to drive the browser.
//
// Implements: protected-resource + AS discovery metadata, Dynamic Client
// Registration (RFC 7591), authorization-code + PKCE(S256), refresh tokens,
// and a human consent step. Consent is granted by the user either on the
// bridge-served page OR in the extension popup (both hit /oauth/decision).
//
// Loopback-only; the whole thing rides on the loopback HTTP server.

import { randomBytes, createHash } from 'node:crypto';
import { state, save } from './state.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(randomBytes(n));
const sha256 = (s) => b64url(createHash('sha256').update(s).digest());
const now = () => Date.now();

const ACCESS_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days (refreshable)
const CODE_TTL_MS = 5 * 60 * 1000;

// Notify the extension (for the toolbar badge) whenever the pending-request count
// changes, so an incoming connection surfaces as an icon indicator + popup entry
// instead of relying on a dedicated consent webpage.
let notifyPending = null;
export function configureOAuth(o) { notifyPending = (o && o.notifyPending) || null; }
function pendingCount() { return [...pending.values()].filter((p) => !p.decided).length; }
function pingPending() { if (notifyPending) { try { notifyPending(pendingCount()); } catch {} } }

// Pending authorization requests awaiting user consent: reqId -> {...}
const pending = new Map();
// Issued-but-unredeemed auth codes: code -> {...}
const codes = new Map();

function readBody(req) {
  return new Promise((resolve) => {
    let b = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1_000_000) { req.destroy(); resolve({ raw: '', form: {}, json: {} }); return; } b += c; });
    req.on('end', () => {
      let json = {}; try { json = JSON.parse(b || '{}'); } catch {}
      const form = {}; try { new URLSearchParams(b).forEach((v, k) => (form[k] = v)); } catch {}
      resolve({ raw: b, form, json });
    });
    req.on('error', () => resolve({ raw: '', form: {}, json: {} }));
  });
}

function json(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function html(res, status, s) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function redirect(res, location) { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); }

function issuer(req) {
  const host = req.headers.host || '127.0.0.1:8787';
  return `http://${host}`;
}
function resourceUrl(req) { return issuer(req) + '/mcp'; }

// --- Discovery ---------------------------------------------------------------
function protectedResourceMeta(req) {
  return { resource: resourceUrl(req), authorization_servers: [issuer(req)], bearer_methods_supported: ['header'] };
}
function authServerMeta(req) {
  const iss = issuer(req);
  return {
    issuer: iss,
    authorization_endpoint: iss + '/oauth/authorize',
    token_endpoint: iss + '/oauth/token',
    registration_endpoint: iss + '/oauth/register',
    scopes_supported: ['browser'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

// --- Token validation (used to protect /mcp) --------------------------------
export function validateToken(authHeader, req) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  if (!m) return null;
  const rec = state.tokens[m[1]];
  if (!rec) return null;
  if (rec.exp && rec.exp < now()) { delete state.tokens[m[1]]; save(); return null; }
  if (rec.resource && rec.resource !== resourceUrl(req)) return null; // audience binding
  const grant = state.grants[rec.client_id];
  if (!grant) return null; // revoked
  grant.lastUsed = now();
  return { client_id: rec.client_id, name: grant.name };
}

export function wwwAuthenticate(req) {
  return `Bearer resource_metadata="${issuer(req)}/.well-known/oauth-protected-resource"`;
}

// --- Agent management (for the extension popup) ------------------------------
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

// Keep every grant's display name distinct. If another (e.g. stale) grant already
// uses the requested name, the newcomer gets a " (2)", " (3)", … suffix — so two
// clients that both call themselves "Claude Code" are still tellable apart. A
// client re-authorizing under its own id keeps the name it already had.
function uniqueGrantName(desired, exceptClientId) {
  const base = String(desired || 'Unnamed agent').trim() || 'Unnamed agent';
  const taken = new Set(Object.values(state.grants).filter((g) => g.client_id !== exceptClientId).map((g) => g.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) { const cand = `${base} (${i})`; if (!taken.has(cand)) return cand; }
}

// Record (or refresh) the grant for an approved consent request, capturing enough
// metadata to tell agents apart in the UI (raw name, callback origin, timestamps).
function createGrant(p) {
  const existing = state.grants[p.client_id];
  const client = state.clients[p.client_id] || {};
  state.grants[p.client_id] = {
    client_id: p.client_id,
    name: existing ? existing.name : uniqueGrantName(p.client_name, p.client_id),
    client_name: p.client_name || 'Unnamed agent',
    resource: p.resource,
    origin: hostOf(p.redirect_uri) || hostOf((client.redirect_uris || [])[0]),
    created: existing ? existing.created : now(),
    lastUsed: existing ? (existing.lastUsed || 0) : 0,
  };
  save();
}

// Garbage-collect only ANCIENT orphan client registrations (no grant, no pending,
// older than the cutoff). We keep recent stale ones VISIBLE (see listStale) so the
// user can see every registration in the Authorized agents list and remove them
// by hand — rather than having them silently swept.
export function gcClients(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const activePending = new Set([...pending.values()].filter((p) => !p.decided).map((p) => p.client_id));
  let removed = 0;
  for (const [cid, c] of Object.entries(state.clients)) {
    if (state.grants[cid]) continue;                    // authorized → keep (needed for refresh)
    if (activePending.has(cid)) continue;               // mid-consent → keep
    if (now() - (c.created || 0) < maxAgeMs) continue;  // recent → keep (stays visible + removable)
    delete state.clients[cid]; removed++;
  }
  if (removed) save();
  return removed;
}

export function listAgents() {
  return Object.values(state.grants).map((g) => ({
    client_id: g.client_id,
    name: g.name,
    client_name: g.client_name || g.name,
    origin: g.origin || '',
    resource: g.resource || '',
    created: g.created || 0,
    lastUsed: g.lastUsed || 0,
  }));
}
export function listPending() {
  return [...pending.values()].filter((p) => !p.decided).map((p) => ({ reqId: p.reqId, client_id: p.client_id, name: p.client_name, origin: hostOf(p.redirect_uri), created: p.created }));
}
// Registrations that are neither active grants nor pending — "stale". Shown in
// the Authorized agents list so ALL grants (active/pending/stale) are visible.
export function listStale() {
  const pend = new Set([...pending.values()].filter((p) => !p.decided).map((p) => p.client_id));
  return Object.values(state.clients)
    .filter((c) => !state.grants[c.client_id] && !pend.has(c.client_id))
    .map((c) => ({ client_id: c.client_id, name: c.client_name, origin: hostOf((c.redirect_uris || [])[0]), created: c.created || 0 }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}
export function removeClient(clientId) { delete state.clients[clientId]; save(); return { ok: true }; }
export function revokeAgent(clientId) {
  delete state.grants[clientId];
  delete state.clients[clientId]; // drop the registration too, so it can't linger invisibly
  for (const [t, r] of Object.entries(state.tokens)) if (r.client_id === clientId) delete state.tokens[t];
  for (const [t, r] of Object.entries(state.refresh)) if (r.client_id === clientId) delete state.refresh[t];
  save();
  return { ok: true };
}
function decide(reqId, approve) {
  const p = pending.get(reqId);
  if (!p || p.decided) return { ok: false, error: 'no such request' };
  p.decided = true; p.approved = !!approve;
  if (approve) {
    const code = rand(24);
    codes.set(code, { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, resource: p.resource, exp: now() + CODE_TTL_MS, name: p.client_name });
    p.code = code;
  }
  pingPending(); // a request left the pending queue → update the badge
  return { ok: true };
}

// Public: apply a consent decision (used by the /oauth/decision route AND the
// Config page). Records the grant on approve; returns the agent redirect (if any).
export function applyDecision(reqId, approve) {
  const p = pending.get(reqId);
  const r = decide(reqId, approve);
  if (!r.ok) return { ok: false };
  if (approve && p) createGrant(p);
  return { ok: true, redirect: finalRedirect(p) };
}

// --- Consent page ------------------------------------------------------------
// Deliberately minimal. Approval happens in the EXTENSION (the toolbar icon shows
// a ● badge → open the popup → Approve), not on this page. This tab is just a
// small waiter that auto-returns to the agent once you approve in the extension
// (it also completes if you approve from the bridge Config page).
function consentPage(p) {
  return `<!doctype html><meta charset=utf-8><title>Approve in the extension</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;background:#14161b;color:#e6e8ec;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}
@media (prefers-color-scheme:light){body{background:#f5f6f8;color:#1b1e24}}
.b{max-width:380px;padding:24px}.who{font-family:ui-monospace,Menlo,monospace;opacity:.85;margin:8px 0 18px;font-size:14px}
.s{font-size:13px;opacity:.65;margin-top:14px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d29922;vertical-align:baseline;margin:0 2px}</style>
<div class=b>
<div style="font-size:16px">Approve this connection in the</div>
<div style="font-size:16px"><b>AI Browser Bridge</b> extension</div>
<div class=who>${escapeHtml(p.client_name)}</div>
<div class=s>Look for the <span class=dot></span> on the toolbar icon, open the popup, and tap <b>Approve</b>. You can leave this tab — it returns automatically.</div>
<div class=s id=w>Waiting for your approval…</div>
</div>
<script>
const reqId=${JSON.stringify(p.reqId)};
setInterval(async()=>{try{const r=await fetch('/oauth/status?reqId='+encodeURIComponent(reqId),{cache:'no-store'});const j=await r.json();
 if(j.redirect){document.getElementById('w').textContent='Approved — returning to the agent…';location.href=j.redirect;}
 else if(j.denied){document.getElementById('w').textContent='Denied.';}}catch{}},1000);
</script>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function finalRedirect(p) {
  if (!p.approved || !p.code) return null;
  const u = new URL(p.redirect_uri);
  u.searchParams.set('code', p.code);
  if (p.stateParam) u.searchParams.set('state', p.stateParam);
  return u.toString();
}

// --- Main router: returns true if it handled the request ---------------------
export async function oauthHandle(req, res, url) {
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
    json(res, 200, protectedResourceMeta(req)); return true;
  }
  if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
    json(res, 200, authServerMeta(req)); return true;
  }

  // Dynamic Client Registration (RFC 7591).
  if (req.method === 'POST' && path === '/oauth/register') {
    const { json: body } = await readBody(req);
    const client_id = 'c_' + rand(12);
    const client = {
      client_id,
      client_name: String(body.client_name || 'Unnamed agent').slice(0, 80),
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris.slice(0, 8) : [],
      token_endpoint_auth_method: 'none',
      created: now(),
    };
    state.clients[client_id] = client;
    gcClients(); // sweep orphaned registrations whenever a new one arrives
    save();
    json(res, 201, { client_id, client_name: client.client_name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    return true;
  }

  // Authorization endpoint — starts the consent flow.
  if (req.method === 'GET' && path === '/oauth/authorize') {
    const q = url.searchParams;
    const client = state.clients[q.get('client_id')];
    const redirect_uri = q.get('redirect_uri');
    if (!client) { html(res, 400, 'unknown client_id'); return true; }
    if (client.redirect_uris.length && redirect_uri && !client.redirect_uris.includes(redirect_uri)) { html(res, 400, 'redirect_uri not registered'); return true; }
    if (q.get('response_type') !== 'code') { html(res, 400, 'response_type must be code'); return true; }
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) { html(res, 400, 'PKCE S256 required'); return true; }
    const reqId = rand(12);
    const p = {
      reqId, client_id: client.client_id, client_name: client.client_name,
      redirect_uri: redirect_uri || (client.redirect_uris[0]),
      code_challenge: q.get('code_challenge'),
      resource: q.get('resource') || resourceUrl(req),
      stateParam: q.get('state') || '',
      created: now(), decided: false,
    };
    // Already-approved client re-authorizing (e.g. after a token expiry/loss):
    // skip consent and hand back a code directly — no NEW approval prompt. The
    // user already trusts this client_id; PKCE + the registered redirect still gate it.
    if (state.grants[client.client_id]) {
      pending.set(reqId, p);
      decide(reqId, true);   // silent approve (grant already exists)
      createGrant(p);        // refresh grant metadata, keep original name/created
      redirect(res, finalRedirect(p)); return true;
    }
    pending.set(reqId, p);
    pingPending(); // new request → light up the extension badge
    html(res, 200, consentPage(p)); return true;
  }

  // Consent decision (from the page OR the extension popup).
  if (req.method === 'POST' && path === '/oauth/decision') {
    const { form, json: jb } = await readBody(req);
    const reqId = form.reqId || jb.reqId;
    const approve = String(form.approve ?? jb.approve) === '1' || form.approve === true || jb.approve === true;
    const p = pending.get(reqId);
    const r = decide(reqId, approve);
    if (!r.ok) { json(res, 400, { error: r.error }); return true; }
    // Approve/deny grant record.
    if (approve && p) createGrant(p);
    // Page form-post → redirect straight back to the agent; popup fetch → JSON.
    const loc = finalRedirect(p);
    const wantsHtml = /text\/html/.test(req.headers.accept || '') && form.reqId;
    if (wantsHtml && loc) { redirect(res, loc); return true; }
    json(res, 200, { ok: true, redirect: loc || null }); return true;
  }

  // Consent status poll (used by the consent page and could be used by popup).
  if (req.method === 'GET' && path === '/oauth/status') {
    const p = pending.get(url.searchParams.get('reqId'));
    if (!p) { json(res, 404, { error: 'unknown' }); return true; }
    if (p.decided && p.approved) json(res, 200, { redirect: finalRedirect(p) });
    else if (p.decided) json(res, 200, { denied: true });
    else json(res, 200, { pending: true });
    return true;
  }

  // Token endpoint.
  if (req.method === 'POST' && path === '/oauth/token') {
    const { form } = await readBody(req);
    const gt = form.grant_type;
    if (gt === 'authorization_code') {
      const rec = codes.get(form.code);
      if (!rec || rec.exp < now()) { json(res, 400, { error: 'invalid_grant' }); return true; }
      codes.delete(form.code); // single-use
      if (rec.redirect_uri && form.redirect_uri && rec.redirect_uri !== form.redirect_uri) { json(res, 400, { error: 'invalid_grant' }); return true; }
      if (!form.code_verifier || sha256(form.code_verifier) !== rec.code_challenge) { json(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' }); return true; }
      const access = rand(32), refresh = rand(32);
      state.tokens[access] = { client_id: rec.client_id, resource: rec.resource, exp: now() + ACCESS_TTL_MS };
      state.refresh[refresh] = { client_id: rec.client_id, resource: rec.resource };
      save();
      json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: 'browser' });
      return true;
    }
    if (gt === 'refresh_token') {
      const rec = state.refresh[form.refresh_token];
      if (!rec || !state.grants[rec.client_id]) { json(res, 400, { error: 'invalid_grant' }); return true; }
      const access = rand(32);
      state.tokens[access] = { client_id: rec.client_id, resource: rec.resource, exp: now() + ACCESS_TTL_MS };
      save();
      json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope: 'browser' });
      return true;
    }
    json(res, 400, { error: 'unsupported_grant_type' }); return true;
  }

  return false;
}
