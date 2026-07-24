// ui.mjs — the bridge's web control plane. A left-nav shell splits BRIDGE items
// (Config, Modules, Rules) from MODULE items (each enabled module's own page).
// Loopback-trust, server-rendered, no build step.

import { state, save } from './state.mjs';
import { PERMISSIONS } from './rules.mjs';
import { listModules, setEnabled, getModule, allSources, allDestinations, allNavLinks, getModuleCtx, uploadModule, deleteModule } from './modules.mjs';
import { listAgents, listPending, listStale, revokeAgent, removeClient, applyDecision } from './oauth.mjs';
import { pairingStatus } from './pairing.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Bridge version (from bridge/package.json) — shown in the nav so it's clear this
// is the BRIDGE's version, distinct from the browser extension's version.
export let BRIDGE_VERSION = '';
try { BRIDGE_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version || ''; } catch {}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Dual-arrows favicon (down filled + up outlined) — matches the extension icon.
const FAVICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3.7 2.4L3.7 9.2L1.8 9.2L5 13.6L8.2 9.2L6.3 9.2L6.3 2.4Z' fill='#3b82f6'/><path d='M9.7 13.6L9.7 6.8L7.8 6.8L11 2.4L14.2 6.8L12.3 6.8L12.3 13.6Z' fill='none' stroke='#3b82f6' stroke-width='1.4' stroke-linejoin='round'/></svg>";
const FAVICON = 'data:image/svg+xml;base64,' + Buffer.from(FAVICON_SVG).toString('base64');
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
<link rel="icon" href="${FAVICON}">
<style>
:root{--bg:#14161b;--card:#1e2128;--fg:#e6e8ec;--mut:#9aa1ac;--line:#2c3038;--ok:#2e9e44;--bad:#e5484d;--accent:#3b82f6;--warn:#d29922;
  --btn:#2a2f38;--btnH:#333a45;--inp:#12141a;--slider:#3a3f48;--chip:#33383f}
@media (prefers-color-scheme: light){
  :root{--bg:#f5f6f8;--card:#ffffff;--fg:#1b1e24;--mut:#5b626d;--line:#e2e5ea;--ok:#1a7f37;--bad:#d1242f;--accent:#2563eb;--warn:#9a6700;
    --btn:#eef0f3;--btnH:#e3e6eb;--inp:#ffffff;--slider:#c4c9d2;--chip:#e6e9ef}
}
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
button{background:var(--btn);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 12px;font-size:13px;cursor:pointer}
button:hover{background:var(--btnH)}button:disabled{opacity:.45;cursor:default}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.bad{background:var(--bad);border-color:var(--bad);color:#fff}
select,input[type=text],input[type=url],textarea{background:var(--inp);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;font-size:13px}
label.chk{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:13px}
.switch{position:relative;display:inline-block;width:40px;height:22px;vertical-align:middle}
.switch input{display:none}
.switch .slider{position:absolute;inset:0;background:var(--slider);border-radius:22px;transition:.15s;cursor:pointer}
.switch .slider:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.15s}
.switch input:checked + .slider{background:var(--accent)}
.switch input:checked + .slider:before{transform:translateX(18px)}
.switch input:disabled + .slider{opacity:.5;cursor:default}
.switch.rec input:checked + .slider{background:var(--bad)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--chip)}.tag.on{background:#1c3a5e;color:#8fc0ff}.tag.off{background:#3a2f18;color:#e9c069}
.tag.allow{background:#123a1e;color:#7fd39b}.tag.deny{background:#3a1518;color:#f0a0a4}
@media (prefers-color-scheme: light){.tag.on{background:#dbeafe;color:#1e40af}.tag.off{background:#fef3c7;color:#92400e}.tag.allow{background:#dcfce7;color:#166534}.tag.deny{background:#fee2e2;color:#991b1b}}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}code{background:var(--inp);padding:1px 5px;border-radius:4px;font-size:12px}
.modhead h1{font-size:18px;margin:0}
.tabrow{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:14px 0 18px}
.tabrow .tab{padding:8px 14px;color:var(--mut);text-decoration:none;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabrow .tab:hover{color:var(--fg)} .tabrow .tab.on{color:var(--fg);border-bottom-color:var(--accent)}
</style>
<aside><div class="brand">AI Browser Bridge${BRIDGE_VERSION ? ` <span style="font-weight:400;color:var(--mut);font-size:11px">v${esc(BRIDGE_VERSION)}</span>` : ''}</div><div class="navh">Bridge</div>${bridgeNav().map(item).join('')}${modSection}</aside>
<main>${body}</main>`;
}

// Module page shell: left-nav + a module header + a row of sub-page tabs.
// Modules call this from their ui.handler with their own tabs/active/body.
export function moduleShell(mod, { tabs = [], active = '', header = '', body = '' }) {
  const tabRow = tabs.length > 1
    ? `<div class="tabrow">${tabs.map((t) => `<a class="tab${active === t.id ? ' on' : ''}" href="/modules/${esc(mod.id)}?tab=${esc(t.id)}">${esc(t.label)}</a>`).join('')}</div>`
    : '';
  const ver = mod.version ? ` <span style="font-weight:400;color:var(--mut);font-size:12px">v${esc(mod.version)}</span>` : '';
  const head = `<div class="modhead"><h1>${esc(mod.name)}${ver}</h1>${header ? `<div class="mut" style="font-size:13px;margin-top:3px">${header}</div>` : ''}</div>${tabRow}`;
  return uiChrome(mod.name, head + body, '/modules/' + mod.id);
}

// --- Pages -------------------------------------------------------------------
function configPage() {
  const pair = pairingStatus();
  const agents = listAgents();
  const pending = listPending();
  const ctx = getModuleCtx();
  const usage = (ctx && ctx.monitor && ctx.monitor.usageByRoot()) || { tmp: 0, perm: 0 };
  const fmtWhen = (ts) => {
    if (!ts) return 'unknown';
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  };
  const agentRows = agents.length ? agents.map((a) => `<tr>
    <td><b>${esc(a.name)}</b>${a.client_name && a.client_name !== a.name ? `<br><span class="mut" style="font-size:11px">registered as “${esc(a.client_name)}”</span>` : ''}</td>
    <td class="mut" style="font-size:12px;line-height:1.7">
      <div><code>${esc(a.client_id)}</code></div>
      ${a.origin ? `<div>callback ${esc(a.origin)}</div>` : ''}
      <div>authorized ${esc(fmtWhen(a.created))} · last used ${a.lastUsed ? esc(fmtWhen(a.lastUsed)) : 'never'}</div>
    </td>
    <td><form method=POST action="/config"><input type=hidden name=action value=revoke><input type=hidden name=client_id value="${esc(a.client_id)}"><button class=bad>Revoke</button></form></td></tr>`).join('') : '<tr><td colspan=3 class="mut">No authorized agents.</td></tr>';
  const pendRows = pending.map((p) => `<tr><td>⏳ <b>${esc(p.name)}</b> <span class="tag off">pending</span></td>
    <td class="mut" style="font-size:12px">${p.origin ? `callback ${esc(p.origin)}<br>` : ''}awaiting your approval</td>
    <td class="row">
    <form method=POST action="/config"><input type=hidden name=action value=approve><input type=hidden name=reqId value="${esc(p.reqId)}"><button class=primary>Approve</button></form>
    <form method=POST action="/config"><input type=hidden name=action value=deny><input type=hidden name=reqId value="${esc(p.reqId)}"><button>Deny</button></form></td></tr>`).join('');
  const stale = listStale();
  const staleRows = stale.map((s) => `<tr>
    <td><span class="mut">${esc(s.name)}</span> <span class="tag">stale</span></td>
    <td class="mut" style="font-size:12px"><div><code>${esc(s.client_id)}</code></div>${s.origin ? `<div>callback ${esc(s.origin)}</div>` : ''}<div>registered ${esc(fmtWhen(s.created))} · never authorized</div></td>
    <td><form method=POST action="/config"><input type=hidden name=action value=remove><input type=hidden name=client_id value="${esc(s.client_id)}"><button>Remove</button></form></td></tr>`).join('');
  const anyRows = pendRows + agentRows.replace('<tr><td colspan=3 class="mut">No authorized agents.</td></tr>', '') + staleRows;
  return uiChrome('Config', `
    <h2>Bridge</h2>
    <div class="card">Pairing: <span class="tag ${pair.paired ? 'on' : 'off'}">${pair.paired ? 'linked' : 'not linked'}</span>
      ${pair.paired && pair.created ? `<span class="mut" style="font-size:12px;margin-left:8px">linked ${esc(new Date(pair.created).toLocaleString())}</span>` : ''}
      <span class="mut" style="font-size:12px;margin-left:8px">Loopback 127.0.0.1 — nothing leaves this device.</span></div>
    <h2>Linked browsers <span class="mut" style="font-size:12px;font-weight:400">agent traffic routes to the active one — switch it here or from any extension</span></h2>
    <div class="card"><div id="browsersBox" class="mut">Loading…</div></div>
    <script>
    (function(){
      function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      async function load(){
        let d; try{ d=await (await fetch('/bridge/status',{cache:'no-store'})).json(); }catch{ return; }
        var box=document.getElementById('browsersBox'); if(!box) return;
        var bs=d.browsers||[];
        if(!bs.length){ box.innerHTML='<span class="mut">No browsers linked yet. Install the extension in a browser and click Link.</span>'; return; }
        box.innerHTML=bs.map(function(b){
          return '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">'
            +'<span style="width:9px;height:9px;border-radius:50%;display:inline-block;background:'+(b.connected?'var(--ok)':'var(--mut)')+'"></span>'
            +'<span class="grow"><b>'+esc(b.name)+'</b> '+(b.active?'<span class="tag on">active</span>':'')
            +' <span class="mut" style="font-size:11px">'+(b.connected?'connected':'offline')+'</span></span>'
            +(b.active?'':'<button data-use="'+esc(b.id)+'" class="primary">Use this browser</button>')
            +'<button data-ren="'+esc(b.id)+'" data-name="'+esc(b.name||'')+'">Rename</button>'
            +'<button data-unlink="'+esc(b.id)+'" class="bad">Unlink</button></div>';
        }).join('');
        box.querySelectorAll('[data-use]').forEach(function(el){el.onclick=async function(){await fetch('/bridge/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({browserId:el.getAttribute('data-use')})});load();};});
        box.querySelectorAll('[data-ren]').forEach(function(el){el.onclick=async function(){var n=prompt('Label for this browser (e.g. Island, Work Edge):',el.getAttribute('data-name')||'');if(n==null||!n.trim())return;await fetch('/bridge/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({browserId:el.getAttribute('data-ren'),name:n.trim()})});load();};});
        box.querySelectorAll('[data-unlink]').forEach(function(el){el.onclick=async function(){if(!confirm('Unlink this browser? It loses access until re-linked.'))return;await fetch('/bridge/unpair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({browserId:el.getAttribute('data-unlink')})});load();};});
      }
      load(); setInterval(load,3000);
    })();
    </script>
    <h2>Authorized agents <span class="mut" style="font-size:12px;font-weight:400">active, pending, and stale — every registration</span></h2>
    <div class="card"><table><thead><tr><th>Agent</th><th>Details</th><th></th></tr></thead><tbody>${anyRows || '<tr><td colspan=3 class="mut">No agents yet.</td></tr>'}</tbody></table></div>
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
  const rules = state.rules || [];
  const nameOfDest = (id) => (dests.find((d) => d.id === id) || {}).name || id;
  const ruleRows = rules.length ? rules.map((r, i) => {
    const deny = r.action === 'deny';
    return `<tr>
      <td class="mut" style="width:22px;text-align:center">${i + 1}</td>
      <td><span class="tag ${deny ? 'deny' : 'allow'}">${deny ? 'DENY' : 'ALLOW'}</span></td>
      <td>${esc(r.source)}</td>
      <td>${esc(nameOfDest(r.destination))}</td>
      <td>${(r.permissions || []).map((p) => `<span class="tag">${esc(p)}</span>`).join(' ')}</td>
      <td><span class="tag ${r.enabled !== false ? 'on' : 'off'}">${r.enabled !== false ? 'on' : 'off'}</span></td>
      <td class="row" style="gap:4px">
        <form method=POST action="/rules"><input type=hidden name=action value=moveup><input type=hidden name=id value="${esc(r.id)}"><button title="Move up"${i === 0 ? ' disabled' : ''}>↑</button></form>
        <form method=POST action="/rules"><input type=hidden name=action value=movedown><input type=hidden name=id value="${esc(r.id)}"><button title="Move down"${i === rules.length - 1 ? ' disabled' : ''}>↓</button></form>
        <form method=POST action="/rules"><input type=hidden name=action value=toggle><input type=hidden name=id value="${esc(r.id)}"><button>${r.enabled !== false ? 'Disable' : 'Enable'}</button></form>
        <form method=POST action="/rules"><input type=hidden name=action value=delete><input type=hidden name=id value="${esc(r.id)}"><button class=bad>Delete</button></form>
      </td></tr>`;
  }).join('') : '<tr><td colspan=7 class="mut">No rules yet. Nothing is permitted until a rule allows it.</td></tr>';
  const srcOpts = sources.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  const dstOpts = dests.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.user ? ' (custom)' : ''}</option>`).join('');
  const permChks = PERMISSIONS.map((p) => `<label class=chk><input type=checkbox name=permissions value="${p}">${p}</label>`).join('');

  const destRows = dests.length ? dests.map((d) => `<tr>
      <td><b>${esc(d.name)}</b> ${d.user ? '<span class="tag">custom</span>' : `<span class="tag on">${esc(d.moduleId || 'module')}</span>`}</td>
      <td class="mut" style="font-size:12px">${(d.patterns || []).map((p) => `<code>${esc(p)}</code>`).join(' ') || '<span class="mut">(empty)</span>'}</td>
      <td>${d.user ? `<form method=POST action="/destinations"><input type=hidden name=action value=delete><input type=hidden name=id value="${esc(d.id)}"><button class=bad>Delete</button></form>` : '<span class="mut" style="font-size:11px">from module</span>'}</td>
    </tr>`).join('') : '<tr><td colspan=3 class="mut">No destinations yet.</td></tr>';

  return uiChrome('Rules', `
    <h2>Rules <span class="mut" style="font-size:12px;font-weight:400">evaluated top-down, first match wins · deny-by-default</span></h2>
    <p class="mut" style="font-size:12px;margin-top:0">Put a rule higher to make it supersede the ones below. A <b>deny</b> at the top blocks everything under it; an <b>allow</b> at the top grants past later denies.</p>
    <div class="card"><table><thead><tr><th>#</th><th>Action</th><th>Source</th><th>Destination</th><th>Permissions</th><th>On</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table></div>
    <h2>Add a rule</h2>
    <form method=POST action="/rules" class="card">
      <input type=hidden name=action value=add>
      <div class="row" style="margin-bottom:10px">
        <label>Effect <select name=effect><option value=allow>allow</option><option value=deny>deny</option></select></label>
        <label>Source <select name=source>${srcOpts}</select></label>
        <label>Destination <select name=destination>${dstOpts || '<option value="">(create one below)</option>'}</select></label>
      </div>
      <div style="margin-bottom:10px">${permChks}</div>
      <button class=primary type=submit>Add rule</button>
      <span class="mut" style="font-size:12px;margin-left:8px">New rules are added at the bottom; reorder with ↑ ↓.</span>
    </form>

    <h2>Destinations</h2>
    <p class="mut" style="font-size:12px;margin-top:0">A destination is a named set of origin / URL patterns. Modules provide some; you can define your own below. Patterns: <code>*.okta.com</code>, <code>https://acme.com/app/*</code>, bare host, or <code>*</code> for everything.</p>
    <div class="card"><table><thead><tr><th>Name</th><th>Patterns</th><th></th></tr></thead><tbody>${destRows}</tbody></table></div>
    <h2>Create a destination</h2>
    <form method=POST action="/destinations" class="card">
      <input type=hidden name=action value=add>
      <div class="row" style="margin-bottom:10px"><label>Name <input type=text name=name placeholder="e.g. Bank sites" style="width:220px"></label></div>
      <div style="margin-bottom:10px"><label style="display:block;margin-bottom:4px">Patterns (one per line or space-separated)</label>
        <textarea name=patterns rows=3 placeholder="*.chase.com&#10;https://www.bankofamerica.com/*" style="width:100%;background:var(--inp);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 8px;font:12px ui-monospace,Menlo,monospace"></textarea></div>
      <button class=primary type=submit>Create destination</button>
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
    else if (form.action === 'remove' && form.client_id) removeClient(String(form.client_id));
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
    const rules = state.rules;
    if (form.action === 'add') {
      const perms = [].concat(form.permissions || []).filter(Boolean);
      const action = form.effect === 'deny' ? 'deny' : 'allow';
      const rid = 'rule-' + Date.now().toString(36) + '-' + (String(form.source || 'x')).replace(/\W+/g, '').slice(0, 8);
      rules.push({ id: rid, action, source: String(form.source), destination: String(form.destination || ''), permissions: perms, enabled: true }); save();
    } else if (form.action === 'delete') { state.rules = rules.filter((r) => r.id !== form.id); save(); }
    else if (form.action === 'toggle') { const r = rules.find((x) => x.id === form.id); if (r) { r.enabled = r.enabled === false; save(); } }
    else if (form.action === 'moveup' || form.action === 'movedown') {
      const i = rules.findIndex((r) => r.id === form.id);
      const j = form.action === 'moveup' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < rules.length) { const t = rules[i]; rules[i] = rules[j]; rules[j] = t; save(); }
    }
    redirect(res, '/rules'); return true;
  }
  if (req.method === 'POST' && p === '/destinations') {
    const { form } = await readBody(req);
    state.destinations = state.destinations || [];
    if (form.action === 'add' && String(form.name || '').trim()) {
      const patterns = String(form.patterns || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const base = String(form.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dest';
      let id = 'dest-' + base, n = 2;
      while (state.destinations.find((d) => d.id === id)) id = 'dest-' + base + '-' + n++;
      state.destinations.push({ id, name: String(form.name).trim(), patterns }); save();
    } else if (form.action === 'delete' && form.id) {
      state.destinations = state.destinations.filter((d) => d.id !== form.id); save();
    }
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
