// ui.mjs — the bridge's web control plane. A left-nav shell splits BRIDGE items
// (Config, Modules, Rules) from MODULE items (each enabled module's own page).
// Loopback-trust, server-rendered, no build step.

import { state, save } from './state.mjs';
import { PERMISSIONS } from './rules.mjs';
import { listModules, setEnabled, getModule, allSources, allDestinations, allNavLinks, getModuleCtx, deleteModule, requestModuleInstall, decideModuleInstall } from './modules.mjs';
import { listAgents, listPending, listStale, revokeAgent, removeClient } from './oauth.mjs';
import { pairingStatus, verifyDecision } from './pairing.mjs';
import { refreshTrayMenu } from './tray.mjs';
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
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)} — Browser Bridge</title>
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
<aside><div class="brand">Browser Bridge${BRIDGE_VERSION ? ` <span style="font-weight:400;color:var(--mut);font-size:11px">v${esc(BRIDGE_VERSION)}</span>` : ''}</div><div class="navh">Bridge</div>${bridgeNav().map(item).join('')}${modSection}</aside>
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
  // Pending requests can be approved from here, but this PAGE never approves anything
  // itself: the control panel is unauthenticated loopback, so a POST from it would let
  // any local process self-grant. The buttons ask the paired EXTENSION to sign the
  // decision (content script -> service worker -> signed POST). Same proof-of-human as
  // the popup. Without the extension present the buttons stay disabled and say so.
  const pendRows = pending.map((p) => `<tr><td>⏳ <b>${esc(p.name)}</b> <span class="tag off">pending</span></td>
    <td class="mut" style="font-size:12px">${p.origin ? `callback ${esc(p.origin)}<br>` : ''}awaiting your approval</td>
    <td><span class="bbdec" data-req="${esc(p.reqId)}">
      <button class="bbok" disabled>Approve</button>
      <button class="bbno" disabled>Deny</button>
      <span class="mut bbmsg" style="font-size:11px;margin-left:6px">extension not detected — use the popup</span>
    </span></td></tr>`).join('');
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
          // The evidence behind the name. Two Chromium forks can both call themselves
          // "Chrome" in the UA, so the brand list is usually what actually tells them
          // apart — show it, and mark which brand the auto-name came from.
          var generic=/^(chromium|google chrome|microsoft edge)$/i;
          var brands=(b.brands||[]).map(function(x){
            var isNoise=/^not/i.test(x.brand)||generic.test(x.brand);
            var picked=!isNoise;
            return '<span class="tag'+(picked?' on':'')+'" title="'+esc(x.brand+' '+(x.version||''))+'">'+esc(x.brand)+(x.version?' '+esc(x.version):'')+'</span>';
          }).join(' ');
          var detail='';
          if(brands||b.ua){
            detail='<div class="mut" style="font-size:11px;margin:3px 0 0 17px;width:100%">'
              +(brands?'<div style="margin-bottom:3px">'+brands+'</div>':'')
              +(b.ua?'<div style="word-break:break-all;opacity:.85"><code>'+esc(b.ua)+'</code></div>':'')
              +'</div>';
          }
          return '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">'
            +'<span style="width:9px;height:9px;border-radius:50%;display:inline-block;background:'+(b.connected?'var(--ok)':'var(--mut)')+'"></span>'
            +'<span class="grow"><b>'+esc(b.name)+'</b> '+(b.active?'<span class="tag on">active</span>':'')
            +(b.renamed?' <span class="tag" title="You named this browser. Reconnects will not overwrite it.">custom name</span>':'')
            +' <span class="mut" style="font-size:11px">'+(b.connected?'connected':'offline')+'</span></span>'
            +(b.active?'':'<button data-use="'+esc(b.id)+'" class="primary">Use this browser</button>')
            +'<button data-ren="'+esc(b.id)+'" data-name="'+esc(b.name||'')+'">Rename</button>'
            +'<button data-unlink="'+esc(b.id)+'" class="bad">Unlink</button>'
            +detail+'</div>';
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
    </div></div>

    <script>
    (function(){
      // Approve/Deny here are relayed to the paired extension, which signs them — this
      // page cannot (and must not be able to) approve on its own. See bridge-page.js.
      var present = false;
      window.addEventListener('message', function(ev){
        if (ev.source !== window || ev.origin !== location.origin) return;
        var m = ev.data; if (!m || m.source !== 'bb-ext') return;
        if (m.type === 'present') { present = true; enable(); return; }
        if (m.type === 'decision-result') {
          var box = document.querySelector('.bbdec[data-req="' + m.reqId + '"]');
          if (!box) return;
          var r = m.result || {};
          if (r.ok === false) { box.querySelector('.bbmsg').textContent = '⚠ ' + (r.error || 'failed');
            box.querySelector('.bbok').disabled = false; box.querySelector('.bbno').disabled = false; }
          else { box.querySelector('.bbmsg').textContent = 'done'; setTimeout(function(){ location.reload(); }, 600); }
        }
      });
      function enable(){
        document.querySelectorAll('.bbdec').forEach(function(box){
          var msg = box.querySelector('.bbmsg'); msg.textContent = '';
          [['.bbok', true], ['.bbno', false]].forEach(function(pair){
            var b = box.querySelector(pair[0]); b.disabled = false;
            b.onclick = function(){
              box.querySelector('.bbok').disabled = true; box.querySelector('.bbno').disabled = true;
              msg.textContent = pair[1] ? 'approving…' : 'denying…';
              window.postMessage({ source:'bb-page', type:'decision', kind:'oauth', reqId: box.getAttribute('data-req'), approve: pair[1] }, location.origin);
            };
          });
        });
      }
      // The content script announces itself on load; ask again in case we loaded first.
      window.postMessage({ source:'bb-page', type:'ping' }, location.origin);
      setTimeout(function(){ if (!present) window.postMessage({ source:'bb-page', type:'ping' }, location.origin); }, 500);
    })();
    </script>

    <h2>Connect AI agents <span class="mut" style="font-size:12px;font-weight:400">write the bridge into each app's MCP config for you</span></h2>
    <div class="card"><div id="cliBox" class="mut">Detecting…</div></div>
    <script>
    (function(){
      function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      var box=document.getElementById('cliBox');
      function tile(c){
        var badge = !c.installed ? '<span class="tag off">not detected</span>'
          : c.configured ? '<span class="tag on">connected</span>'
          : '<span class="tag off">not connected</span>';
        var warn = (c.usesShim && c.installed && !c.npxFound)
          ? '<div class="mut" style="font-size:11px;color:var(--warn);margin-top:2px">needs Node/npx installed to run</div>' : '';
        var btn = !c.installed ? ''
          : c.configured
            ? '<button data-act="disconnect" data-id="'+esc(c.id)+'">Disconnect</button>'
            : '<button class="primary" data-act="connect" data-id="'+esc(c.id)+'">Connect</button>';
        return '<div class="card row" style="align-items:flex-start">'
          +'<div style="flex:1"><b>'+esc(c.name)+'</b> '+badge
          +'<div class="mut" style="font-size:11px">'+esc(c.transport==='http-native'?'native OAuth':(c.transport==='remote'?'native remote MCP':'via mcp-remote shim'))+' · '+esc(c.file)+'</div>'+warn+'</div>'
          +btn+'</div>';
      }
      function render(list){
        var other = '<div class="card" style="margin-top:6px"><b>Any other MCP agent</b>'
          +'<div class="mut" style="font-size:12px;margin-top:4px">Point it at <code>http://127.0.0.1:8787/mcp</code> (Streamable HTTP + OAuth 2.1 — registration is automatic). For CLI agents, e.g.:</div>'
          +'<pre style="font-size:11px;background:var(--bg);border:1px solid var(--line);padding:6px 8px;border-radius:6px;overflow-x:auto;user-select:all;margin:6px 0 4px">claude mcp add --transport http browser-bridge http://127.0.0.1:8787/mcp</pre>'
          +'<div class="mut" style="font-size:11px">The first connection opens a consent page — approve it in the extension popup (● badge). The grant is permanent until you revoke it here.</div></div>';
        if(!list||!list.length){box.innerHTML='<span class="mut">No known AI agents detected.</span>'+other;return;}
        box.innerHTML = list.map(tile).join('')
          +'<div class="mut" style="font-size:12px;margin-top:8px">After connecting: <b>restart that app</b>, then approve the connection in the Browser Bridge <b>extension popup</b> (● badge on the toolbar icon).</div>'
          +other;
        Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'),function(b){
          b.onclick=async function(){
            var act=b.getAttribute('data-act'), id=b.getAttribute('data-id');
            b.disabled=true; b.textContent=act==='connect'?'Connecting…':'Removing…';
            var r=await (await fetch('/bridge/clients/'+act,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})).json();
            if(r&&r.warn) alert(r.warn);
            if(r&&r.ok===false&&r.error) alert(r.error);
            load();
          };
        });
      }
      async function load(){ try{ render((await (await fetch('/bridge/clients',{cache:'no-store'})).json()).clients); }catch{ box.innerHTML='<span class="mut">Unavailable.</span>'; } }
      load();
    })();
    </script>

    <h2>Updates <span class="mut" style="font-size:12px;font-weight:400">install the latest release from GitHub</span></h2>
    <div class="card"><div id="updBox" class="mut">Loading…</div></div>
    <script>
    (function(){
      function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      var box=document.getElementById('updBox');
      function render(d){
        if(!d){box.innerHTML='<span class="mut">Unavailable.</span>';return;}
        if(d.error){box.innerHTML='<span class="mut">Update check unavailable: '+esc(d.error)+'</span>';return;}
        // Both install channels get the same UI: status, an Update & restart button when
        // an update is applicable, and the auto-update toggle. The apply/config endpoints
        // route to the right implementation (git fast-forward vs. zip download+swap).
        var isZip = d.channel==='zip';
        var canApply = isZip ? d.updateAvailable : d.canFastForward;
        var status;
        if(isZip){
          status = d.updateAvailable ? '<b style="color:var(--accent)">Update available → v'+esc(d.latest||'')+'</b>'
            : d.latest ? '<b style="color:var(--ok)">Up to date</b> — on v'+esc(d.version||'?')
            : '<b style="color:var(--ok)">Up to date</b> <span class="mut">— no releases published yet</span>';
        } else {
          status = d.canFastForward ? '<b style="color:var(--accent)">Update available → '+esc(d.tag||'')+'</b> ('+d.behind+' commit'+(d.behind===1?'':'s')+' behind)'
            : !d.tag ? '<b style="color:var(--ok)">Up to date</b> <span class="mut">— no releases published yet</span>'
            : d.atLatest ? '<b style="color:var(--ok)">Up to date</b> — on '+esc(d.tag||'')
            : (d.ahead>0) ? '<b style="color:var(--warn)">Ahead of latest release ('+esc(d.tag||'')+')</b> — auto-update paused'
            : !d.clean ? '<b style="color:var(--warn)">Local changes present</b> — auto-update paused'
            : '<b style="color:var(--warn)">Update to '+esc(d.tag||'')+' not fast-forwardable</b>';
        }
        var meta = isZip
          ? 'Bridge <b>v'+esc(d.version||'?')+'</b> · downloaded release ('+esc(d.platform||'')+')'+(d.latest?' · latest release v'+esc(d.latest):'')+(d.repo?'<br>source '+esc(d.repo):'')
          : 'Bridge <b>v'+esc(d.version||'?')+'</b> · '+esc(d.branch||'')+' @ '+esc(d.sha||'?')+(d.tag?' · latest release '+esc(d.tag)+' @ '+esc(d.tagSha||'?'):'')+'<br>source '+esc(d.remoteUrl||'');
        box.innerHTML =
          '<div class="row"><span class="grow">'+status+'</span>'
            +'<button id="chk">Check now</button>'
            +(canApply?'<button id="apply" class="primary">Update &amp; restart</button>':'')+'</div>'
          +(d.warning?'<div class="mut" style="font-size:11px;margin-top:5px;color:var(--warn)">⚠ '+esc(d.warning)+'</div>':'')
          +'<div class="mut" style="font-size:12px;margin-top:6px">'+meta+'</div>'
          +'<label class="row" style="margin-top:10px;gap:8px;cursor:pointer"><input type="checkbox" id="auto"'+(d.autoUpdate?' checked':'')+'> '
            +'<span>Automatically install the latest release when available</span></label>';
        var chk=document.getElementById('chk'); if(chk) chk.onclick=async function(){box.innerHTML='<span class="mut">Checking GitHub…</span>';render(await (await fetch('/bridge/update/check',{method:'POST'})).json());};
        var ap=document.getElementById('apply'); if(ap) ap.onclick=async function(){if(!confirm('Update the bridge and restart it now?'))return;box.innerHTML='<span class="mut">Updating &amp; restarting… this page will reconnect.</span>';var r=await (await fetch('/bridge/update/apply',{method:'POST'})).json();if(!r.ok){box.innerHTML='<span class="mut">Update failed: '+esc(r.error||'')+'</span>';}else{setTimeout(function(){location.reload();},4000);}};
        var au=document.getElementById('auto'); if(au) au.onchange=async function(){await fetch('/bridge/update/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({autoUpdate:au.checked})});load();};
      }
      async function load(){ try{ render(await (await fetch('/bridge/update',{cache:'no-store'})).json()); }catch{ box.innerHTML='<span class="mut">Unavailable.</span>'; } }
      load();
    })();
    </script>`, '/config');
}

// Built-in page for a module that ships no UI of its own. Everything shown is what the
// module registered with the bridge, so it stays accurate without the module doing
// anything: what it can do, where it may act, and which rules govern it.
function defaultModulePage(mod) {
  const dests = allDestinations().filter((d) => d.moduleId === mod.id);
  const rules = (state.rules || []).filter((r) => r.moduleId === mod.id);
  const tools = Object.entries(mod.tools || {});
  const row = (k, v) => `<tr><td style="width:150px" class="mut">${esc(k)}</td><td>${v}</td></tr>`;

  const about = `<div class="card"><table>
    ${row('Module id', `<code>${esc(mod.id)}</code>`)}
    ${mod.version ? row('Version', esc(mod.version)) : ''}
    ${row('Status', `<span class="tag on">enabled</span>`)}
    ${mod.capabilities && mod.capabilities.length ? row('Extension capabilities', mod.capabilities.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ')) : ''}
  </table>${mod.description ? `<div class="mut" style="font-size:12px;margin-top:8px">${esc(mod.description)}</div>` : ''}</div>`;

  const toolRows = tools.length ? tools.map(([name, t]) => `<tr>
      <td><code>${esc(name)}</code>${t.verb ? ` <span class="tag">${esc(t.verb)}</span>` : ''}</td>
      <td class="mut" style="font-size:12px">${esc(String(t.description || '').split('\n')[0]).slice(0, 200)}</td></tr>`).join('')
    : '<tr><td colspan=2 class="mut">This module provides no tools.</td></tr>';

  const destRows = dests.length ? dests.map((d) => `<tr>
      <td><b>${esc(d.name || d.id)}</b><div class="mut" style="font-size:11px"><code>${esc(d.id)}</code></div></td>
      <td>${(d.patterns || []).length
        ? (d.patterns || []).map((x) => `<code>${esc(x)}</code>`).join(' ')
        : '<span class="tag off">no patterns — rules using this destination deny everything</span>'}</td></tr>`).join('')
    : '<tr><td colspan=2 class="mut">This module declares no destinations.</td></tr>';

  const ruleRows = rules.length ? rules.map((r) => `<tr>
      <td><span class="tag ${r.action === 'deny' ? 'deny' : 'allow'}">${r.action === 'deny' ? 'deny' : 'allow'}</span> ${esc(r.source)}</td>
      <td>→ ${esc(r.destination)}</td>
      <td>${(r.permissions || []).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')
    : '<tr><td colspan=3 class="mut">No rules reference this module.</td></tr>';

  const body = `${about}
    <h2>Tools <span class="mut" style="font-size:12px;font-weight:400">exposed to authorized agents over MCP</span></h2>
    <div class="card"><table><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>${toolRows}</tbody></table></div>
    <h2>Destinations <span class="mut" style="font-size:12px;font-weight:400">where this module's rules may apply</span></h2>
    <div class="card"><table><thead><tr><th>Destination</th><th>Patterns</th></tr></thead><tbody>${destRows}</tbody></table></div>
    <h2>Rules</h2>
    <div class="card"><table><thead><tr><th>Source</th><th>Destination</th><th>Permissions</th></tr></thead><tbody>${ruleRows}</tbody></table>
      <div class="mut" style="font-size:12px;margin-top:8px">Edit these in the <a href="/rules">Rule builder</a>. This module ships no settings page of its own — everything above is what it registered with the bridge.</div></div>`;
  return moduleShell(mod, { header: 'Provided by the module — no custom settings page.', body });
}

function modulesPage() {
  const mods = listModules();
  const rows = mods.length ? mods.map((m) => `
    <div class="card row">
      <div style="flex:1"><b>${esc(m.name)}</b> <span class="tag ${m.enabled ? 'on' : 'off'}">${m.enabled ? 'ENABLED' : 'disabled'}</span>
        <div class="mut" style="font-size:12px">${esc(m.description)}</div></div>
      <form method=POST action="/modules/toggle"><input type=hidden name=id value="${esc(m.id)}"><input type=hidden name=enabled value="${m.enabled ? '0' : '1'}">
        <button class="${m.enabled ? '' : 'primary'}">${m.enabled ? 'Disable' : 'Enable'}</button></form>
      ${m.enabled ? `<a href="/modules/${esc(m.id)}"><button>${(() => { const mm = getModule(m.id); return mm && mm.ui && typeof mm.ui.handler === 'function' ? 'Configure' : 'Details'; })()} →</button></a>` : ''}
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
      document.getElementById('upMsg').textContent = j.ok ? 'Waiting for approval — open the extension popup (● badge) and approve the install.' : ('Failed: '+(j.error||''));
      if (j.ok) setTimeout(()=>location.reload(), 15000);
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
    // NOTE: no approve/deny here — OAuth consent is approved only from the extension
    // popup, signed by the paired browser (see /oauth/decision). Approving over the
    // unauthenticated control-plane would let any local process self-grant.
    if (form.action === 'revoke' && form.client_id) revokeAgent(String(form.client_id));
    else if (form.action === 'remove' && form.client_id) removeClient(String(form.client_id));
    else if (form.action === 'clear' && form.root) {
      const ctx = getModuleCtx(); if (ctx && ctx.monitor && ctx.monitor.clearRoot) ctx.monitor.clearRoot(form.root === 'perm' ? 'perm' : 'tmp');
    }
    redirect(res, '/config'); return true;
  }

  if (req.method === 'GET' && p === '/modules') { htmlRes(res, modulesPage()); return true; }
  if (req.method === 'POST' && p === '/modules/toggle') { const { form } = await readBody(req); setEnabled(String(form.id), form.enabled === '1'); refreshTrayMenu(); redirect(res, '/modules'); return true; }
  // Uploading a module is arbitrary code execution in the bridge, and this route is
  // loopback-only but unauthenticated — so it only STAGES the install. The code is
  // written/executed exclusively after a human approves in the extension popup
  // (signed with the pairing key, verified below at /modules/decision).
  if (req.method === 'POST' && p === '/modules/upload') {
    let b = {}; try { b = JSON.parse(await readRaw(req) || '{}'); } catch {}
    jsonRes(res, requestModuleInstall(b.name, b.code)); return true;
  }
  if (req.method === 'POST' && p === '/modules/decision') {
    let b = {}; try { b = JSON.parse(await readRaw(req) || '{}'); } catch {}
    const approve = b.approve === true || b.approve === 1 || b.approve === '1';
    if (!verifyDecision(String(b.reqId || ''), approve, b.mac)) {
      jsonRes(res, { ok: false, error: 'approval must be signed by the paired browser (approve in the extension popup)' }, 403); return true;
    }
    jsonRes(res, await decideModuleInstall(String(b.reqId || ''), approve)); return true;
  }
  if (req.method === 'POST' && p === '/modules/delete') { const { form } = await readBody(req); await deleteModule(String(form.id)); refreshTrayMenu(); redirect(res, '/modules'); return true; }

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
    // A module needn't ship a UI. Render what the bridge already knows about it rather
    // than 404-ing a link the Modules page itself offers.
    if (mod) { htmlRes(res, defaultModulePage(mod)); return true; }
  }
  return false;
}
