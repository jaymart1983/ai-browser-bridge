// popup.js — thin extension popup. The browser's only job is to PAIR with the
// local bridge and execute its signed commands; all configuration (modules,
// rules, tabs, recording, storage) lives in the bridge web UI. The popup shows
// pairing status, authorized agents, and links into the bridge.

const $ = (id) => document.getElementById(id);
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'POPUP', action, ...extra });

let pwValue = null;
let dashboardUrl = 'http://127.0.0.1:8787/';
let extPaired = false;

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

  pwValue = s.defaultPassword || '';
  $('pwCode').value = pwValue;
  dashboardUrl = dashUrlFrom(s.bridgeUrl);
  $('openDash').disabled = !s.wsConnected;
  $('openDash').title = s.wsConnected ? dashboardUrl : 'Bridge not running';

  const paired = s.paired === true;
  extPaired = paired;
  let host = '127.0.0.1:8787';
  try { host = new URL(dashboardUrl).host; } catch {}
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  const place = isLoopback ? 'this device' : host;
  $('bridgeMeta').textContent = !s.wsConnected ? '○ Local bridge — not running'
    : paired ? `🔒 Linked · local bridge on ${place} (${host})`
      : `🖥 Local bridge on ${place} (${host}) — loopback only`;
  $('bridgeMeta').title = `A helper on your own computer at ${host}. Traffic stays on this device (loopback). Linking pairs this browser to it with a one-time key exchange.`;

  $('pwSection').classList.toggle('hidden', paired);
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
  if (extPaired !== bridgePaired) { $('bridgeMeta').textContent = '⚠ Bridge changed — re-link needed'; }
  const box = $('agentList');
  box.innerHTML = '';
  const pend = data.pending || [];
  const agents = data.agents || [];
  if (!pend.length && !agents.length) { box.innerHTML = '<div class="muted" style="font-size:11px;padding:4px 0">No agents yet. Add this bridge in your AI client, then approve it here.</div>'; return; }
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
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = '✅ ' + a.name;
    const rv = document.createElement('button'); rv.textContent = 'Revoke';
    rv.onclick = async () => { if (!confirm('Revoke ' + a.name + '?')) return; await fetch(bridgeBase() + '/bridge/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: a.client_id }) }); renderAgents(); };
    row.append(nm, rv); box.appendChild(row);
  }
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
$('copyPw').addEventListener('click', async () => {
  if (!pwValue) return;
  try { await navigator.clipboard.writeText(pwValue); $('copyPw').textContent = 'Copied!'; setTimeout(() => ($('copyPw').textContent = 'Copy'), 1200); }
  catch { $('copyPw').textContent = 'Copy failed'; }
});
$('regenPw').addEventListener('click', async () => {
  const r = await send('regenerateDefault');
  if (r && r.password) { pwValue = r.password; $('pwCode').value = pwValue; }
  refresh();
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
