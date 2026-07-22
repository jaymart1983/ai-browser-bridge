// ui.mjs — the bridge's web control plane. A left-nav shell splits BRIDGE items
// (Config, Modules, Rules) from MODULE items (each enabled module's own page).
// Loopback-trust, server-rendered, no build step.

import { state, save } from './state.mjs';
import { PERMISSIONS } from './rules.mjs';
import { listModules, setEnabled, getModule, allSources, allDestinations, allNavLinks, getModuleCtx, uploadModule, deleteModule } from './modules.mjs';
import { listAgents, listPending, revokeAgent, applyDecision } from './oauth.mjs';
import { pairingStatus } from './pairing.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; };

function readBody(req) {
  return new Promise((resolve) => {
    let b = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > 2_000_000) { req.destroy(); resolve({ form: {} }); return; } b += c; });
    req.on('end', () => { const form = {}; try { new URLSearchParams(b).forEach((v, k) => { form[k] = form[k] ? [].concat(form[k], v) : v; }); } catch {} resolve({ form }); });
    req.on('error', () => resolve({ form: {} }));
  });
}
function readRaw(req) {
  return new Promise((resolve) => {
    let b = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > 4_000_000) { req.destroy(); resolve(''); return; } b += c; });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
function htmlRes(res, body, status = 200) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); }
function jsonRes(res, obj, status = 200) { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store' }); res.end(b); }
function redirect(res, to) { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); }

const bridgeNav = () => [{ label: 'Config', href: '/config' }, { label: 'Modules', href: '/modules' }, { label: 'Rules', href: '/rules' }];
const moduleNav = () => allNavLinks().map((l) => ({ label: l.label, href: l.href, moduleId: l.moduleId }));

// Shared shell: left nav (Bridge + Modules sections) + main content.
export function uiChrome(title, body, active = '') {
  const item = (l) => `<a href="${esc(l.href)}"${active === l.href ? ' class="on"' : ''}>${esc(l.label)}</a>`;
  const modItems = moduleNav();
  const modSection = modItems.length ? `<div class="navh">Modules</div>${modItems.map(item).join('')}` : '';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)} — AI Browser Bridge</title>
<style>
:root{--bg:#14161b;--card:#1e2128;--fg:#e6e8ec;--mut:#9aa1ac;--line:#2c3038;--ok:#2e9e44;--bad:#e5484d;--accent:#3b82f6;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;min-height:100vh}
aside{width:200px;flex:none;border-right:1px solid var(--line);padding:16px 10px}
aside .brand{font-size:14px;font-weight:600;padding:0 8px 10px}
.navh{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:16px 8px 5px}
aside a{display:block;padding:7px 10px;border-radius:7px;color:var(--fg);text-decoration:none;font-size:13px}
aside a:hover{background:var(--card)} aside a.on{background:var(--accent);color:#fff}
main{flex:1;padding:22px 26px;min-width:0}
h2{font-size:16px;margin:20px 0 8px}h2:first-child{margin-top:0}.mut{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
button{background:#2a2f38;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 12px;font-size:13px;cursor:pointer}
button:hover{background:#333a45}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.bad{background:var(--bad);border-color:var(--bad);color:#fff}
select,input[type=text],input[type=url]{background:#12141a;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;font-size:13px}
label.chk{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:13px}
.switch{position:relative;display:inline-block;width:40px;height:22px;vertical-align:middle}
.switch input{display:none}
.switch .slider{position:absolute;inset:0;background:#3a3f48;border-radius:22px;transition:.15s;cursor:pointer}
.switch .slider:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.15s}
.switch input:checked + .slider{background:var(--accent)}
.switch input:checked + .slider:before{transform:translateX(18px)}
.switch input:disabled + .slider{opacity:.5;cursor:default}
.switch.rec input:checked + .slider{background:var(--bad)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:#33383f}.tag.on{background:#1c3a5e;color:#8fc0ff}.tag.off{background:#3a2f18;color:#e9c069}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}code{background:#12141a;padding:1px 5px;border-radius:4px;font-size:12px}
.modhead h1{font-size:18px;margin:0}
.tabrow{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:14px 0 18px}
.tabrow .tab{padding:8px 14px;color:var(--mut);text-decoration:none;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabrow .tab:hover{color:var(--fg)} .tabrow .tab.on{color:var(--fg);border-bottom-color:var(--accent)}
</style>
<aside><div class="brand">AI Browser Bridge</div><div class="navh">Bridge</div>${bridgeNav().map(item).join('')}${modSection}</aside>
<main>${body}</main>`;
}

// Module page shell: left-nav + a module header + a row of sub-page tabs.
// Modules call this from their ui.handler with their own tabs/active/body.
export function moduleShell(mod, { tabs = [], active = '', header = '', body = '' }) {
  const tabRow = tabs.length > 1
    ? `<div class="tabrow">${tabs.map((t) => `<a class="tab${active === t.id ? ' on' : ''}" href="/modules/${esc(mod.id)}?tab=${esc(t.id)}">${esc(t.label)}</a>`).join('')}</div>`
    : '';
  const head = `<div class="modhead"><h1>${esc(mod.name)}</h1>${header ? `<div class="mut" style="font-size:13px;margin-top:3px">${header}</div>` : ''}</div>${tabRow}`;
  return uiChrome(mod.name, head + body, '/modules/' + mod.id);
}

// --- Pages -------------------------------------------------------------------
function configPage() {
  const pair = pairingStatus();
  const agents = listAgents();
  const pending = listPending();
  const ctx = getModuleCtx();
  const usage = (ctx && ctx.monitor && ctx.monitor.usageByRoot()) || { tmp: 0, perm: 0 };
  const agentRows = agents.length ? agents.map((a) => `<tr><td>${esc(a.name)}</td><td class="mut">${esc(a.client_id)}</td>
    <td><form method=POST action="/config"><input type=hidden name=action value=revoke><input type=hidden name=client_id value="${esc(a.client_id)}"><button class=bad>Revoke</button></form></td></tr>`).join('') : '<tr><td colspan=3 class="mut">No authorized agents.</td></tr>';
  const pendRows = pending.map((p) => `<tr><td>⏳ ${esc(p.name)}</td><td></td><td class="row">
    <form method=POST action="/config"><input type=hidden name=action value=approve><input type=hidden name=reqId value="${esc(p.reqId)}"><button class=primary>Approve</button></form>
    <form method=POST action="/config"><input type=hidden name=action value=deny><input type=hidden name=reqId value="${esc(p.reqId)}"><button>Deny</button></form></td></tr>`).join('');
  return uiChrome('Config', `
    <h2>Bridge</h2>
    <div class="card">Pairing: <span class="tag ${pair.paired ? 'on' : 'off'}">${pair.paired ? 'linked' : 'not linked'}</span>
      <span class="mut" style="font-size:12px;margin-left:8px">Loopback 127.0.0.1 — nothing leaves this device.</span></div>
    <h2>Authorized agents</h2>
    <div class="card"><table><thead><tr><th>Agent</th><th>Client id</th><th></th></tr></thead><tbody>${pendRows}${agentRows}</tbody></table></div>
    <h2>Storage</h2>
    <div class="card"><div class="row">
      <span class="grow">Temporary <b>${fmtBytes(usage.tmp)}</b></span>
      <form method=POST action="/config"><input type=hidden name=action value=clear><input type=hidden name=root value=tmp><button>Clear Tmp</button></form>
      <span class="grow">Permanent <b>${fmtBytes(usage.perm)}</b></span>
      <form method=POST action="/config"><input type=hidden name=action value=clear><input type=hidden name=root value=perm><button>Clear Perm</button></form>
    </div></div>`, '/config');
}

function modulesPage() {
  const mods = listModules();
  const rows = mods.length ? mods.map((m) => `
    <div class="card row">
      <div style="flex:1"><b>${esc(m.name)}</b> <span class="tag ${m.enabled ? 'on' : 'off'}">${m.enabled ? 'ENABLED' : 'disabled'}</span>
        <div class="mut" style="font-size:12px">${esc(m.description)}</div></div>
      <form method=POST action="/modules/toggle"><input type=hidden name=id value="${esc(m.id)}"><input type=hidden name=enabled value="${m.enabled ? '0' : '1'}">
        <button class="${m.enabled ? '' : 'primary'}">${m.enabled ? 'Disable' : 'Enable'}</button></form>
      ${m.enabled ? `<a href="/modules/${esc(m.id)}"><button>Configure →</button></a>` : ''}
      <form method=POST action="/modules/delete" onsubmit="return confirm('Delete the ${esc(m.name)} module? This removes its file, rules, and settings.')"><input type=hidden name=id value="${esc(m.id)}"><button class=bad>Delete</button></form>
    </div>`).join('') : '<div class="card mut">No modules found in bridge/modules/.</div>';
  const upload = `<h2>Add a module</h2>
    <div class="card">
      <p class="mut" style="font-size:12px;margin-top:0">Upload a module package — a single <code>.mjs</code> file that exports a manifest. It runs in the bridge (loopback, your machine).</p>
      <div class="row"><input type=file id=modfile accept=".mjs"> <button id=upBtn class=primary>Upload</button> <span id=upMsg class=mut style="font-size:12px"></span></div>
    </div>
    <script>
    document.getElementById('upBtn').onclick=async()=>{
      const f=document.getElementById('modfile').files[0];
      if(!f){document.getElementById('upMsg').textContent='Pick a .mjs file first.';return;}
      const code=await f.text();
      document.getElementById('upMsg').textContent='Uploading…';
      const r=await fetch('/modules/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name,code})});
      const j=await r.json();
      document.getElementById('upMsg').textContent = j.added&&j.added.length ? 'Added: '+j.added.join(', ') : (j.ok? 'Saved (no new module id detected — check the file exports a default manifest).' : 'Failed');
      setTimeout(()=>location.reload(),700);
    };
    </script>`;
  return uiChrome('Modules', `<h2>Capability modules</h2><p class="mut">Each module adds artifacts, tools, and rules. Nothing is permitted until a module is enabled and a rule allows it.</p>${rows}${upload}`, '/modules');
}

function rulesPage() {
  const sources = allSources();
  const dests = allDestinations();
  const ruleRows = (state.rules || []).map((r) => `
    <tr><td>${esc(r.source)}</td><td>${esc((dests.find((d) => d.id === r.destination) || {}).name || r.destination)}</td>
      <td>${(r.permissions || []).map((p) => `<span class="tag">${esc(p)}</span>`).join(' ')}</td>
      <td><span class="tag ${r.enabled !== false ? 'on' : 'off'}">${r.enabled !== false ? 'on' : 'off'}</span></td>
      <td class="row">
        <form method=POST action="/rules"><input type=hidden name=action value=toggle><input type=hidden name=id value="${esc(r.id)}"><button>${r.enabled !== false ? 'Disable' : 'Enable'}</button></form>
        <form method=POST action="/rules"><input type=hidden name=action value=delete><input type=hidden name=id value="${esc(r.id)}"><button class=bad>Delete</button></form>
      </td></tr>`).join('') || '<tr><td colspan=5 class="mut">No rules yet.</td></tr>';
  const srcOpts = sources.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  const dstOpts = dests.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  const permChks = PERMISSIONS.map((p) => `<label class=chk><input type=checkbox name=permissions value="${p}">${p}</label>`).join('');
  return uiChrome('Rules', `
    <h2>Rules <span class="mut" style="font-size:12px;font-weight:400">Source → Destination : Permissions</span></h2>
    <div class="card"><table><thead><tr><th>Source</th><th>Destination</th><th>Permissions</th><th>Enabled</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table></div>
    <h2>Add a rule</h2>
    <form method=POST action="/rules" class="card">
      <input type=hidden name=action value=add>
      <div class="row" style="margin-bottom:10px">
        <label>Source <select name=source>${srcOpts}</select></label>
        <label>Destination <select name=destination>${dstOpts || '<option>(enable a module first)</option>'}</select></label>
      </div>
      <div style="margin-bottom:10px">${permChks}</div>
      <button class=primary type=submit>Add rule</button>
    </form>`, '/rules');
}

// --- Router (returns true if handled) ----------------------------------------
export async function uiRoutes(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/bridge/nav') { jsonRes(res, { bridge: bridgeNav(), modules: moduleNav() }); return true; }
  if (req.method === 'GET' && p === '/config') { htmlRes(res, configPage()); return true; }
  if (req.method === 'POST' && p === '/config') {
    const { form } = await readBody(req);
    if (form.action === 'revoke' && form.client_id) revokeAgent(String(form.client_id));
    else if ((form.action === 'approve' || form.action === 'deny') && form.reqId) {
      applyDecision(String(form.reqId), form.action === 'approve');
    } else if (form.action === 'clear' && form.root) {
      const ctx = getModuleCtx(); if (ctx && ctx.monitor && ctx.monitor.clearRoot) ctx.monitor.clearRoot(form.root === 'perm' ? 'perm' : 'tmp');
    }
    redirect(res, '/config'); return true;
  }

  if (req.method === 'GET' && p === '/modules') { htmlRes(res, modulesPage()); return true; }
  if (req.method === 'POST' && p === '/modules/toggle') { const { form } = await readBody(req); setEnabled(String(form.id), form.enabled === '1'); redirect(res, '/modules'); return true; }
  if (req.method === 'POST' && p === '/modules/upload') {
    let b = {}; try { b = JSON.parse(await readRaw(req) || '{}'); } catch {}
    jsonRes(res, await uploadModule(b.name, b.code)); return true;
  }
  if (req.method === 'POST' && p === '/modules/delete') { const { form } = await readBody(req); await deleteModule(String(form.id)); redirect(res, '/modules'); return true; }

  if (req.method === 'GET' && p === '/rules') { htmlRes(res, rulesPage()); return true; }
  if (req.method === 'POST' && p === '/rules') {
    const { form } = await readBody(req);
    if (form.action === 'add') {
      const perms = [].concat(form.permissions || []).filter(Boolean);
      const rid = 'rule-' + (state.rules.length) + '-' + (String(form.source || 'x')).replace(/\W+/g, '').slice(0, 8);
      state.rules.push({ id: rid, source: String(form.source), destination: String(form.destination), permissions: perms, enabled: true }); save();
    } else if (form.action === 'delete') { state.rules = state.rules.filter((r) => r.id !== form.id); save(); }
    else if (form.action === 'toggle') { const r = state.rules.find((x) => x.id === form.id); if (r) { r.enabled = r.enabled === false; save(); } }
    redirect(res, '/rules'); return true;
  }

  if (req.method === 'POST' && p === '/artifacts/populate') {
    const { form } = await readBody(req);
    const mod = getModule(String(form.moduleId));
    if (mod && mod.populate) { try { await mod.populate(getModuleCtx()); } catch {} }
    redirect(res, form.back || ('/modules/' + (form.moduleId || ''))); return true;
  }

  const m = /^\/modules\/([a-z0-9_-]+)(\/.*)?$/i.exec(p);
  if (m) {
    const mod = getModule(m[1]);
    if (mod && mod.ui && typeof mod.ui.handler === 'function') {
      await mod.ui.handler(req, res, url, getModuleCtx(), { uiChrome, moduleShell, esc, readBody, htmlRes, jsonRes, redirect, mod });
      return true;
    }
  }
  return false;
}
