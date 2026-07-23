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

  $('version').textContent = 'v' + (s.version || '');
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
  $('bridgeMeta').textContent = !s.wsConnected ? '○ Local bridge — not running'
    : paired ? `🔒 Linked · local bridge on ${place} (${host})`
      : `🖥 Local bridge on ${place} (${host}) — loopback only`;
  $('bridgeMeta').title = `A helper on your own computer at ${host}. Traffic stays on this device (loopback). Linking pairs this browser to it with a one-time key exchange.`;

  $('agentsSection').classList.toggle('hidden', !s.wsConnected);
  $('navSection').classList.toggle('hidden', !s.wsConnected);
  $('linkBtn').textContent = paired ? 'Unlink' : 'Link';
  $('linkBtn').className = paired ? '' : 'primary';
  $('linkBtn').disabled = !s.wsConnected;
  $('linkBtn').title = !s.wsConnected ? 'Start the bridge first' : paired ? 'Unpair this browser' : 'Pair this browser with this local bridge';

  if (s.wsConnected) { renderAgents(); renderNav(); }
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
  // "This browser" active-state + Use button (multi-browser routing).
  const browsers = data.browsers || [];
  const isActive = !!(myBrowserId && data.activeBrowser && data.activeBrowser === myBrowserId);
  const tbRow = $('thisBrowserRow');
  if (tbRow) {
    const show = bridgePaired && !!myBrowserId;
    tbRow.classList.toggle('hidden', !show);
    if (show) {
      $('thisBrowser').textContent = (isActive ? '✅ ' : '○ ') + myBrowserName + (isActive ? ' — active' : ' — inactive')
        + (browsers.length > 1 ? ' · ' + browsers.length + ' linked' : '');
      $('thisBrowser').style.color = isActive ? 'var(--ok)' : 'var(--mut)';
      $('useBtn').classList.toggle('hidden', isActive);
    }
  }

  const box = $('agentList');
  box.innerHTML = '';
  const pend = data.pending || [];
  const agents = data.agents || [];
  const stale = data.stale || [];
  if (!pend.length && !agents.length && !stale.length) { box.innerHTML = '<div class="muted" style="font-size:11px;padding:4px 0">No agents yet. Add this bridge in your AI client, then approve it here.</div>'; return; }
  for (const p of pend) {
    const row = document.createElement('div'); row.className = 'agent';
    const nm = document.createElement('span'); nm.className = 'nm pend'; nm.textContent = '⏳ ' + p.name;
    const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Approve';
    ok.onclick = async () => { await fetch(bridgeBase() + '/oauth/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqId: p.reqId, approve: 1 }) }); renderAgents(); };
    const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Deny';
    no.onclick = async () => { await fetch(bridgeBase() + '/oauth/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqId: p.reqId, approve: 0 }) }); renderAgents(); };
    row.append(nm, ok, no); box.appendChild(row);
  }
  for (const a of agents) {
    const row = document.createElement('div'); row.className = 'agent';
    const info = document.createElement('div');
    info.className = 'nm';
    info.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';
    const nm = document.createElement('span'); nm.textContent = '✅ ' + a.name;
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

// ---- events ----
$('useBtn').addEventListener('click', async () => {
  if (!myBrowserId) return;
  try { await fetch(bridgeBase() + '/bridge/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browserId: myBrowserId }) }); } catch {}
  renderAgents();
});
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
