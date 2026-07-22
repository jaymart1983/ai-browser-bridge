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
export function listAgents() {
  return Object.values(state.grants).map((g) => ({ client_id: g.client_id, name: g.name, created: g.created, lastUsed: g.lastUsed || 0 }));
}
export function listPending() {
  return [...pending.values()].filter((p) => !p.decided).map((p) => ({ reqId: p.reqId, name: p.client_name, created: p.created }));
}
export function revokeAgent(clientId) {
  delete state.grants[clientId];
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
  return { ok: true };
}

// Public: apply a consent decision (used by the /oauth/decision route AND the
// Config page). Records the grant on approve; returns the agent redirect (if any).
export function applyDecision(reqId, approve) {
  const p = pending.get(reqId);
  const r = decide(reqId, approve);
  if (!r.ok) return { ok: false };
  if (approve && p) { state.grants[p.client_id] = { client_id: p.client_id, name: p.client_name, resource: p.resource, created: now() }; save(); }
  return { ok: true, redirect: finalRedirect(p) };
}

// --- Consent page ------------------------------------------------------------
function consentPage(p) {
  return `<!doctype html><meta charset=utf-8><title>Authorize agent</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#14161b;color:#e6e8ec;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.card{background:#1e2128;border:1px solid #2c3038;border-radius:14px;padding:28px;max-width:420px}
h1{font-size:18px;margin:0 0 6px} .mut{color:#9aa1ac;font-size:13px}
.who{background:#12141a;border:1px solid #2c3038;border-radius:8px;padding:10px 12px;margin:16px 0;font-family:ui-monospace,Menlo,monospace}
button{font:14px inherit;border-radius:8px;padding:9px 16px;border:1px solid #2c3038;cursor:pointer;margin-right:8px}
.ok{background:#2e9e44;border-color:#2e9e44;color:#fff}.no{background:#2a2f38;color:#e6e8ec}
.wait{color:#9aa1ac;font-size:13px;margin-top:14px}</style>
<div class=card>
<h1>Authorize this agent?</h1>
<div class=mut>An AI agent is requesting permission to drive your browser through the AI Browser Bridge.</div>
<div class=who>${escapeHtml(p.client_name)}</div>
<div class=mut>Approve here, or from the extension popup. You can revoke it anytime in the popup.</div>
<form method=POST action="/oauth/decision" style="margin-top:18px">
  <input type=hidden name=reqId value="${p.reqId}">
  <button class=ok name=approve value=1>Approve</button>
  <button class=no name=approve value=0>Deny</button>
</form>
<div class=wait id=w></div>
<script>
// If approval happens in the extension popup instead, finish automatically.
const reqId=${JSON.stringify(p.reqId)};
setInterval(async()=>{try{const r=await fetch('/oauth/status?reqId='+encodeURIComponent(reqId),{cache:'no-store'});const j=await r.json();
 if(j.redirect){document.getElementById('w').textContent='Approved — returning to the agent…';location.href=j.redirect;}
 else if(j.denied){document.getElementById('w').textContent='Denied.';}}catch{}},1000);
</script></div>`;
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
    state.clients[client_id] = client; save();
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
    pending.set(reqId, p);
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
    if (approve && p) { state.grants[p.client_id] = { client_id: p.client_id, name: p.client_name, resource: p.resource, created: now() }; save(); }
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
