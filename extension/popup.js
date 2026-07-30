// popup.js — thin extension popup. The browser's only job is to PAIR with the
// local bridge and execute its signed commands; all configuration (modules,
// rules, tabs, recording, storage) lives in the bridge web UI. The popup shows
// pairing status, authorized agents, and links into the bridge.

const $ = (id) => document.getElementById(id);
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'POPUP', action, ...extra });

let dashboardUrl = 'http://127.0.0.1:8787/';
let extPaired = false;
let myBrowserId = null;
let myBrowserName = 'This browser';

function dashUrlFrom(ws) {
  try { return String(ws || 'ws://127.0.0.1:8787/agent').replace(/^ws/, 'http').replace(/\/agent.*$/, '/'); }
  catch { return 'http://127.0.0.1:8787/'; }
}
const bridgeBase = () => dashboardUrl.replace(/\/$/, '');

async function refresh() {
  let s;
  try { s = await send('getState'); } catch { $('wsText').textContent = 'Service worker unavailable'; return; }
  if (!s) return;

  $('version').textContent = 'extension v' + (s.version || '');
  $('version').title = 'Extension version. The bridge shows its own version in the control panel.';
  $('runDot').className = 'dot ok';
  $('wsDot').className = 'dot ' + (s.wsConnected ? 'ok' : 'bad');
  $('wsText').textContent = s.wsConnected ? 'Connected to bridge (running)' : 'Bridge not running — start it';

  dashboardUrl = dashUrlFrom(s.bridgeUrl);
  $('openDash').disabled = !s.wsConnected;
  $('openDash').title = s.wsConnected ? dashboardUrl : 'Bridge not running';

  const paired = s.paired === true;
  extPaired = paired;
  myBrowserId = s.browserId || null;
  myBrowserName = s.browserName || 'This browser';
  let host = '127.0.0.1:8787';
  try { host = new URL(dashboardUrl).host; } catch {}
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  const place = isLoopback ? 'this device' : host;
  $('bridgeMeta').textContent = s.pairError ? '⚠ ' + s.pairError
    : !s.wsConnected ? '○ Local bridge — not running'
    : paired ? `🔒 Linked · local bridge on ${place} (${host})`
      : `🖥 Local bridge on ${place} (${host}) — loopback only`;
  $('bridgeMeta').style.color = s.pairError ? 'var(--bad)' : '';
  $('bridgeMeta').title = `A helper on your own computer at ${host}. Traffic stays on this device (loopback). Linking pairs this browser to it with a one-time key exchange.`;

  $('agentsSection').classList.toggle('hidden', !s.wsConnected);
  $('navSection').classList.toggle('hidden', !s.wsConnected);
  if (s.embedded) {
    // Embedded mode: the host application owns the trust relationship — no
    // linking/unlinking from here.
    $('linkBtn').textContent = 'Managed';
    $('linkBtn').className = '';
    $('linkBtn').disabled = true;
    $('linkBtn').title = 'This bridge is managed by its host application.';
  } else {
    $('linkBtn').textContent = paired ? 'Unlink' : 'Link';
    $('linkBtn').className = paired ? '' : 'primary';
    $('linkBtn').disabled = !s.wsConnected;
    $('linkBtn').title = !s.wsConnected ? 'Start the bridge first' : paired ? 'Unpair this browser' : 'Pair this browser with this local bridge';
  }

  if (s.wsConnected) { renderTabActions(); renderAgents(); renderNav(); renderUpdate(); }
}

// Focused-tab actions: ask the bridge what enabled modules let you do with the tab
// you're looking at (e.g. Deep Research "Record this tab") and render one-click
// buttons. Reflects the current focused tab each time the popup opens.
async function renderTabActions() {
  const sec = $('tabActionsSection');
  if (!sec) return;
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch { tab = null; }
  if (!tab || !/^https?:/i.test(tab.url || '')) { sec.classList.add('hidden'); return; }
  let actions = [];
  try { actions = ((await (await fetch(bridgeBase() + '/bridge/tab-actions?url=' + encodeURIComponent(tab.url) + '&tabId=' + tab.id, { cache: 'no-store' })).json()).actions) || []; }
  catch { sec.classList.add('hidden'); return; }
  if (!actions.length) { sec.classList.add('hidden'); return; }
  let host = tab.url; try { host = new URL(tab.url).host; } catch {}
  $('tabActionsLabel').textContent = 'This tab · ' + host;
  const box = $('tabActionsList');
  box.innerHTML = '';
  for (const a of actions) {
    const row = document.createElement('div'); row.className = 'row'; row.style.marginBottom = '4px';
    const b = document.createElement('button');
    b.className = a.on ? '' : 'primary';
    b.style.flex = '1';
    b.textContent = a.label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fetch(bridgeBase() + '/bridge/tab-actions/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moduleId: a.moduleId, id: a.id, tabId: tab.id, url: tab.url }) });
      } catch {}
      renderTabActions();
    };
    row.appendChild(b);
    box.appendChild(row);
  }
  sec.classList.remove('hidden');
}

// Show a prompt when a newer release is available. Works for both install channels:
// zip installs expose `updateAvailable` + `latest`; git installs expose `canFastForward` + `tag`.
// The Update button hits the bridge's apply endpoint, which downloads/fast-forwards and restarts.
async function renderUpdate() {
  const sec = $('updateSection');
  if (!sec) return;
  let d;
  try { d = await (await fetch(bridgeBase() + '/bridge/update', { cache: 'no-store' })).json(); } catch { sec.classList.add('hidden'); return; }
  const can = d && (d.channel === 'zip' ? d.updateAvailable : d.canFastForward);
  if (!can) { sec.classList.add('hidden'); return; }
  const label = d.channel === 'zip' ? ('v' + (d.latest || '')) : (d.tag || 'latest');
  $('updateText').innerHTML = 'Update available → <b>' + label + '</b>';
  sec.classList.remove('hidden');
  const btn = $('updateBtn');
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    $('updateText').textContent = 'Updating & restarting…';
    try {
      const r = await (await fetch(bridgeBase() + '/bridge/update/apply', { method: 'POST' })).json();
      if (r && r.ok === false) { $('updateText').textContent = '⚠ ' + (r.error || 'Update failed'); btn.disabled = false; }
      else { setTimeout(refresh, 5000); } // bridge restarts; refresh reconnects
    } catch { $('updateText').textContent = '⚠ Update failed'; btn.disabled = false; }
  };
}

async function renderAgents() {
  let data;
  try { data = await (await fetch(bridgeBase() + '/bridge/status', { cache: 'no-store' })).json(); } catch { return; }
  const bridgePaired = !!(data.pairing && data.pairing.paired);
  if (extPaired !== bridgePaired) {
    $('bridgeMeta').textContent = '⚠ Bridge changed — re-link needed';
  } else if (bridgePaired && data.pairing && data.pairing.created) {
    const d = new Date(data.pairing.created);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const base = $('bridgeMeta').textContent.replace(/\s·\slinked .*$/, '');
    $('bridgeMeta').textContent = base + ' · linked ' + when;
    $('bridgeMeta').title = 'Linked ' + d.toLocaleString();
  }
  // Linked-browsers list — show ALL of them; the browser viewing this popup is
  // marked "(this browser)". Names come from the bridge, so renames appear here.
  const browsers = data.browsers || [];
  const bSec = $('browsersSection'), bList = $('browserList');
  if (bSec && bList) {
    bSec.classList.toggle('hidden', !(bridgePaired && browsers.length));
    bList.innerHTML = '';
    for (const b of browsers) {
      const mine = b.id === myBrowserId;
      const row = document.createElement('div'); row.className = 'agent';
      const info = document.createElement('div');
      info.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
      const nm = document.createElement('span');
      nm.textContent = (b.active ? '● ' : '○ ') + (b.name || 'Browser') + (mine ? ' (this browser)' : '');
      nm.style.color = b.active ? 'var(--ok)' : (mine ? 'var(--accent)' : 'var(--fg)');
      nm.style.fontWeight = (mine || b.active) ? '600' : '400';
      const sub = document.createElement('span');
      sub.style.cssText = 'font-size:10px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      sub.textContent = (b.active ? 'active · ' : '') + (b.connected ? 'connected' : 'offline');
      info.append(nm, sub);
      row.append(info);
      if (!b.active) {
        const use = document.createElement('button');
        use.className = mine ? 'primary' : '';
        use.textContent = mine ? 'Use this browser' : 'Use';
        use.title = 'Route agent traffic to ' + (b.name || 'this browser');
        use.onclick = async () => {
          try { await fetch(bridgeBase() + '/bridge/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browserId: b.id }) }); } catch {}
          renderAgents();
        };
        row.append(use);
      }
      bList.appendChild(row);
    }
  }

  const box = $('agentList');
  box.innerHTML = '';
  const pend = data.pending || [];
  const pendMods = data.pendingModules || [];
  const agents = data.agents || [];
  const stale = data.stale || [];
  if (!pend.length && !pendMods.length && !agents.length && !stale.length) { box.innerHTML = '<div class="muted" style="font-size:11px;padding:4px 0">No agents yet. Add this bridge in your AI client, then approve it here.</div>'; return; }
  // Both pending kinds route through the service worker, which SIGNS the decision
  // with the pairing key (the bridge rejects any unsigned approval — no
  // self-granting by code). `action` picks the SW handler + bridge endpoint.
  const pendRow = (label, sub, action, reqId) => {
    const row = document.createElement('div'); row.className = 'agent';
    const info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
    const nm = document.createElement('span'); nm.className = 'nm pend'; nm.textContent = label;
    info.appendChild(nm);
    if (sub) {
      const s2 = document.createElement('span');
      s2.style.cssText = 'font-size:10px;color:var(--mut)';
      s2.textContent = sub;
      info.appendChild(s2);
    }
    const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Approve';
    ok.onclick = async () => { const r = await send(action, { reqId, approve: true }); if (r && r.ok === false && r.error) nm.textContent = '⚠ ' + r.error; renderAgents(); };
    const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Deny';
    no.onclick = async () => { await send(action, { reqId, approve: false }); renderAgents(); };
    row.append(info, ok, no); box.appendChild(row);
  };
  for (const p of pend) pendRow('⏳ ' + p.name, '', 'oauthDecision', p.reqId);
  // Module installs = JavaScript that will RUN inside the bridge. Say so plainly.
  for (const m of pendMods) pendRow('⏳ Install module “' + m.name + '”', 'runs code in the bridge · ' + Math.round((m.bytes || 0) / 1024) + ' KB', 'moduleDecision', m.reqId);
  for (const a of agents) {
    const row = document.createElement('div'); row.className = 'agent';
    const info = document.createElement('div');
    info.className = 'nm';
    info.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
    const nm = document.createElement('span'); nm.textContent = '✅ ' + a.name;
    // Recently active (a request in the last 8h) → highlight the agent in blue.
    const recentlyUsed = a.lastUsed && (Date.now() - a.lastUsed) < 8 * 60 * 60 * 1000;
    if (recentlyUsed) { nm.style.color = 'var(--accent)'; nm.style.fontWeight = '600'; }
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:10px;color:#9aa1ac;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const bits = [];
    if (a.origin) bits.push(a.origin);
    bits.push(a.lastUsed ? 'used ' + relTime(a.lastUsed) : 'never used');
    sub.textContent = bits.join(' · ');
    sub.title = 'client id: ' + a.client_id;
    info.append(nm, sub);
    const rv = document.createElement('button'); rv.textContent = 'Revoke';
    rv.onclick = async () => { if (!confirm('Revoke ' + a.name + '?')) return; await fetch(bridgeBase() + '/bridge/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: a.client_id }) }); renderAgents(); };
    row.append(info, rv); box.appendChild(row);
  }
  for (const s of stale) {
    const row = document.createElement('div'); row.className = 'agent';
    const info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
    const nm = document.createElement('span'); nm.className = 'muted'; nm.textContent = '○ ' + s.name;
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:10px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    sub.textContent = (s.origin ? s.origin + ' · ' : '') + 'stale · never authorized';
    sub.title = 'client id: ' + s.client_id;
    info.append(nm, sub);
    const rm = document.createElement('button'); rm.textContent = 'Remove';
    rm.onclick = async () => { await fetch(bridgeBase() + '/bridge/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: s.client_id }) }); renderAgents(); };
    row.append(info, rm); box.appendChild(row);
  }
}

function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

async function renderNav() {
  let data;
  try { data = await (await fetch(bridgeBase() + '/bridge/nav', { cache: 'no-store' })).json(); } catch { return; }
  const mods = data.modules || [];
  const box = $('navLinks');
  box.innerHTML = '';
  $('navSection').classList.toggle('hidden', mods.length === 0);
  for (const l of mods) {
    const row = document.createElement('div'); row.className = 'modrow';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = l.label;
    const b = document.createElement('button'); b.textContent = 'Open';
    b.onclick = () => chrome.tabs.create({ url: bridgeBase() + l.href });
    row.append(nm, b); box.appendChild(row);
  }
}

// ---- events ---- (per-browser "Use" buttons are wired in renderAgents)
$('openDash').addEventListener('click', () => { if (!$('openDash').disabled) chrome.tabs.create({ url: bridgeBase() + '/config' }); });
$('linkBtn').addEventListener('click', async () => {
  const s = await send('getState');
  if (s && s.paired) {
    if (!confirm('Unlink this browser from the bridge? Agents lose access until you re-link.')) return;
    await send('unpair');
    try { await fetch(bridgeBase() + '/bridge/unpair', { method: 'POST' }); } catch {}
  } else {
    await send('pair');
  }
  setTimeout(refresh, 400);
});

refresh();
setInterval(refresh, 2500);
