// popup.js — thin extension popup. The browser's only job is to PAIR with the
// local bridge and execute its signed commands; all configuration (tabs, modules,
// recording, storage) and linking itself live in the bridge web UI. This popup is a
// status readout: one line for the bridge, the agents awaiting approval, and a gear
// into settings.

const $ = (id) => document.getElementById(id);
const send = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'POPUP', action, ...extra });

let dashboardUrl = 'http://127.0.0.1:8787/';
let extPaired = false;
// What the BRIDGE says about pairing (null until /bridge/status answers once). Kept
// separate from the extension's own view so a disagreement between the two is visible
// rather than averaged away.
let bridgeSaysPaired = null;
let myBrowserId = null;
let myBrowserName = 'This browser';

function dashUrlFrom(ws) {
  try { return String(ws || 'ws://127.0.0.1:8787/agent').replace(/^ws/, 'http').replace(/\/agent.*$/, '/'); }
  catch { return 'http://127.0.0.1:8787/'; }
}
const bridgeBase = () => dashboardUrl.replace(/\/$/, '');

// The popup polls every 2.5s, and each section used to clear and rebuild its DOM on
// every tick — which reads as a visible flash even when nothing changed. Sections now
// re-render only when their data actually differs from the last paint. Returns true
// when the caller should redraw.
const _sigs = {};
function changed(key, value) {
  const sig = JSON.stringify(value);
  if (_sigs[key] === sig) return false;
  _sigs[key] = sig;
  return true;
}

// Write only on a real change. `el.textContent = same string` still tears down the text
// node and builds a new one, and `el.className = same value` still dirties the attribute
// — so the "nothing changed" poll was producing a dozen DOM mutations a tick, which is
// the flicker. These make an unchanged poll a no-op.
const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
const setCls = (el, v) => { if (el && el.className !== v) el.className = v; };
const setTitle = (el, v) => { if (el && el.getAttribute('title') !== v) el.setAttribute('title', v); };
// classList.add/remove notify MutationObservers even when the token is already in the
// wanted state. Harmless (the class value is unchanged, so nothing repaints) but it
// makes "is this popup churning?" impossible to answer by measurement — so check first.
const setHidden = (el, hide) => {
  if (!el) return;
  if (el.classList.contains('hidden') !== !!hide) el.classList.toggle('hidden', !!hide);
};

async function refresh() {
  let s;
  try { s = await send('getState'); } catch { $('wsText').textContent = 'Service worker unavailable'; return; }
  if (!s) return;

  setCls($('runDot'), 'dot ok');

  // EMBEDDED MODE: the host application provides the interface, so this popup is a
  // status readout and nothing else. Branch BEFORE touching any standalone element —
  // renderEmbedded owns everything it shows (including the version label).
  if (s.embedded) return renderEmbedded(s);

  setText($('version'), 'extension v' + (s.version || ''));
  setTitle($('version'), 'Extension version. The bridge shows its own version in the control panel.');

  dashboardUrl = dashUrlFrom(s.bridgeUrl);
  const paired = s.paired === true;

  // Three states, and only three. Everything else — where the bridge is, when it was
  // linked, which browsers are attached — lives on the settings page; repeating it here
  // made a status readout that needed reading. The gear is hidden in the red state
  // because there is no settings page to open when nothing is there.
  const state = !s.wsConnected ? 'down' : (paired && bridgeSaysPaired !== false) ? 'ok' : 'unlinked';
  const TEXT = {
    ok: 'Connected to Bridge',
    unlinked: 'Go to Settings to link bridge',
    down: 'No bridge detected',
  };
  setCls($('wsDot'), 'dot ' + (state === 'ok' ? 'ok' : state === 'unlinked' ? 'link' : 'bad'));
  setCls($('wsText'), 'grow' + (state === 'unlinked' ? ' link' : state === 'down' ? ' bad' : ''));
  setText($('wsText'), s.pairError ? '⚠ ' + s.pairError : TEXT[state]);
  setTitle($('wsText'), state === 'ok' ? `Paired with the bridge at ${hostOf(dashboardUrl)} and connected.`
    : state === 'unlinked' ? 'The bridge is running but this browser is not paired with it yet. Open settings to link.'
      : 'Nothing is answering on the bridge address. Start Browser Bridge.');

  // Gear only when there is somewhere to go.
  setHidden($('openDash'), state === 'down');
  setTitle($('openDash'), 'Bridge settings');
  extPaired = paired;
  myBrowserId = s.browserId || null;
  myBrowserName = s.browserName || 'This browser';
  // ONE owner per section. This used to show navSection here and then renderNav would
  // hide it again in the same tick when there were no modules — the section appeared
  // and vanished every poll, which is the flicker. Whoever has the data decides;
  // refresh only handles the disconnected case, where those renderers don't run at all.
  setHidden($('agentsSection'), !s.wsConnected);
  if (!s.wsConnected) {
    for (const id of ['navSection', 'tabActionsSection', 'updateSection', 'browsersSection']) {
      setHidden($(id), true);
    }
    return;
  }
  renderTabActions(); renderAgents(); renderNav(); renderUpdate();
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return '127.0.0.1:8787'; } };

// Embedded readout: is the bridge reachable, where is it, and is the host's agent
// actually using it. No linking, no agent approvals, no control-panel link, no module
// nav, no update prompt — the host application owns all of that.
async function renderEmbedded(s) {
  // Hide the ENTIRE standalone status block, not just its buttons: leaving it up
  // produced a popup that said "Connected to bridge (running)" directly above
  // "Bridge not reachable". One section owns this readout.
  for (const id of ['statusSection', 'tabActionsSection', 'updateSection', 'browsersSection', 'agentsSection', 'navSection']) {
    setHidden($(id), true);
  }
  setHidden($('embeddedSection'), false);

  // The socket target is known from the service worker even when the bridge is down,
  // so the address is ALWAYS accurate — /health only enriches it (version, agent).
  let where = '—';
  try { where = new URL(dashUrlFrom(s.bridgeUrl)).host; } catch { /* keep — */ }

  // Accept only a real status payload. An older/mismatched service worker answers an
  // unknown action with {ok:false,error:…}, which previously rendered as
  // "undefined:undefined" — treat anything unrecognised as "not reachable".
  const raw = await send('embeddedStatus').catch(() => null);
  const st = raw && raw.ok === true && raw.host ? raw : null;
  const stale = !!(raw && raw.ok === false && /unknown popup action/i.test(String(raw.error || '')));
  if (st) where = `${st.host}:${st.port}`;

  setCls($('embBridgeDot'), 'dot ' + (st ? 'ok' : 'bad'));
  setText($('embBridgeText'), st ? 'Bridge running'
    : stale ? 'Extension out of date — reload it' : 'Bridge not reachable');
  setTitle($('embBridgeText'), st ? `The bridge at ${where} answered a status request.`
    : stale ? 'This extension build is older than the popup it is serving. Reload the extension.'
      : `No status answer from ${where}. The host application may not be running.`);

  // "the browser is attached" and "the agent is using it" fail independently — saying
  // only one hides the other.
  const agent = st && st.agent;
  const agentName = (agent && agent.name) || 'Agent';
  const browserOk = st ? !!st.browserConnected : !!s.wsConnected;
  const agentOk = !!(agent && agent.active);
  setCls($('embAgentDot'), 'dot ' + (agentOk ? 'ok' : (st ? 'warn' : 'bad')));
  setText($('embAgentText'), !st ? `${agentName} — unknown`
    : agentOk ? `${agentName} connected`
    : agent.lastSeen ? `${agentName} idle · last call ${relTime(agent.lastSeen)}`
      : `${agentName} — no calls yet`);
  setTitle($('embAgentText'), 'Whether the host application has made an authorized call through the bridge recently.');

  setText($('embMeta'), `${where} · browser ${browserOk ? 'attached' : 'not attached'}`);
  setTitle($('embMeta'), `The bridge listens on ${where} (loopback only). "browser attached" means this extension's socket is open.`);

  // Report the BRIDGE version here. The extension is bundled by the host application,
  // so its manifest version is the HOST's version number — showing that under a
  // "Browser Bridge" heading just misidentifies which component you're looking at.
  setText($('version'), st && st.version ? 'bridge v' + st.version : '');
  $('version').title = 'Bridge version. This extension is bundled by the host application, so its own version tracks that app.';
}

// Focused-tab actions: ask the bridge what enabled modules let you do with the tab
// you're looking at (e.g. Deep Research "Record this tab") and render one-click
// buttons. Reflects the current focused tab each time the popup opens.
async function renderTabActions() {
  const sec = $('tabActionsSection');
  if (!sec) return;
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch { tab = null; }
  if (!tab || !/^https?:/i.test(tab.url || '')) { setHidden(sec, true); return; }
  let actions = [];
  try { actions = ((await (await fetch(bridgeBase() + '/bridge/tab-actions?url=' + encodeURIComponent(tab.url) + '&tabId=' + tab.id, { cache: 'no-store' })).json()).actions) || []; }
  catch { setHidden(sec, true); return; }
  if (!actions.length) { setHidden(sec, true); return; }
  let host = tab.url; try { host = new URL(tab.url).host; } catch {}
  setHidden(sec, false);
  if (!changed('tabActions', { host, actions })) return; // nothing to repaint
  setText($('tabActionsLabel'), 'This tab · ' + host);
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
  setHidden(sec, false);
}

// Show a prompt when a newer release is available. Works for both install channels:
// zip installs expose `updateAvailable` + `latest`; git installs expose `canFastForward` + `tag`.
// The Update button hits the bridge's apply endpoint, which downloads/fast-forwards and restarts.
async function renderUpdate() {
  const sec = $('updateSection');
  if (!sec) return;
  let d;
  try { d = await (await fetch(bridgeBase() + '/bridge/update', { cache: 'no-store' })).json(); } catch { setHidden(sec, true); return; }
  const can = d && (d.channel === 'zip' ? d.updateAvailable : d.canFastForward);
  if (!can) { setHidden(sec, true); return; }
  const label = d.channel === 'zip' ? ('v' + (d.latest || '')) : (d.tag || 'latest');
  setHidden(sec, false);
  // Guarded like every other section: rewriting innerHTML on each 2.5s poll rebuilt
  // these nodes constantly, which is the flash. It also re-enabled the button mid-update,
  // so "Updating & restarting…" could flip back to a live button while the bridge
  // was still restarting.
  if (!changed('update', { label, channel: d.channel })) return;
  $('updateText').innerHTML = 'Update available → <b>' + label + '</b>';
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
  // The extension and the bridge can disagree — a bridge reinstalled or its state file
  // replaced leaves the extension holding a key nothing accepts. That reads as "linked"
  // here while every command fails, so it must surface. It is a LINK problem, so the
  // status line reports it as one on the next tick rather than as a separate note.
  bridgeSaysPaired = bridgePaired;
  // Linked-browsers list — show ALL of them; the browser viewing this popup is
  // marked "(this browser)". Names come from the bridge, so renames appear here.
  const browsers = data.browsers || [];
  const bSec = $('browsersSection'), bList = $('browserList');
  if (bSec && bList && changed('browsers', { paired: bridgePaired, browsers, me: myBrowserId })) {
    setHidden(bSec, !(bridgePaired && browsers.length));
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

  const pend = data.pending || [];
  const pendMods = data.pendingModules || [];
  const agents = data.agents || [];
  const stale = data.stale || [];
  // `lastUsed` ticks constantly and only drives a relative-time label, so exclude it
  // from the signature — otherwise the list would repaint (and flash) every poll.
  if (!changed('agents', { pend, pendMods, stale, agents: agents.map((a) => ({ ...a, lastUsed: undefined })) })) return;
  const box = $('agentList');
  box.innerHTML = '';
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
  setHidden($('navSection'), mods.length === 0);
  if (!changed('nav', mods)) return;
  const box = $('navLinks');
  box.innerHTML = '';
  for (const l of mods) {
    const row = document.createElement('div'); row.className = 'modrow';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = l.label;
    const b = document.createElement('button'); b.textContent = 'Open';
    b.onclick = () => chrome.tabs.create({ url: bridgeBase() + l.href });
    row.append(nm, b); box.appendChild(row);
  }
}

// ---- events ---- (per-browser "Use" buttons are wired in renderAgents)
// Linking and unlinking both live on the settings page now — the popup is a readout.
$('openDash').addEventListener('click', () => chrome.tabs.create({ url: bridgeBase() + '/config' }));

refresh();
setInterval(refresh, 2500);
