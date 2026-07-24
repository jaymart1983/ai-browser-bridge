// modules/research.mjs — the Deep Research capability (car / real-estate).
// Config = a per-tab matrix (Access / Storage / Record) with a global row that
// toggles ALL tabs and sets the default for new tabs. Activity = native
// recordings view. Plus tools to query what was recorded.

const DEST = 'research-tabs';

const PRESETS = [
  { label: 'AutoTrader', pattern: '*.autotrader.com' },
  { label: 'ACV Auctions', pattern: '*.acvauctions.com' },
  { label: 'Cars.com', pattern: '*.cars.com' },
  { label: 'CarGurus', pattern: '*.cargurus.com' },
  { label: 'Zillow', pattern: '*.zillow.com' },
  { label: 'Redfin', pattern: '*.redfin.com' },
];

const research = (ctx) => (ctx.state.artifacts.research = ctx.state.artifacts.research || {});
function contentsOf(ctx) {
  const a = research(ctx).destinations && research(ctx).destinations[DEST];
  return (a && a.contents) || [];
}
function storageDefault(ctx) { return research(ctx).storageDefault === 'perm' ? 'perm' : 'tmp'; }
function storageMap(ctx) { return research(ctx).storage || {}; }
function effStorage(ctx, origin) { const m = storageMap(ctx); return m[origin] === 'perm' || m[origin] === 'tmp' ? m[origin] : storageDefault(ctx); }
function hostOf(origin) { try { return new URL(origin).host; } catch { return ''; } }
function allowed(ctx, origin) {
  const c = contentsOf(ctx);
  if (c.includes('*') || c.includes(origin)) return true;
  const host = hostOf(origin);
  return c.some((p) => p.startsWith('*.') && (host === p.slice(2) || host.endsWith(p.slice(1))));
}
const globalAll = (ctx) => contentsOf(ctx).includes('*');
const shotNum = (file) => { const m = /(\d+)\.(?:jpg|png)$/.exec(file || ''); return m ? m[1] : null; };

function setStorageOverride(ctx, origin, value) {
  const r = research(ctx); r.storage = r.storage || {};
  if (value) r.storage[origin] = value; else delete r.storage[origin];
  ctx.save();
}

// Deep-scan captured network bodies for vehicle-like records (VIN + make/model).
function extractVehicles(events) {
  const out = new Map();
  const scan = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(scan); return; }
    const v = o.vehicle || o;
    const vin = o.vin || o.vehicle_vin || v.vin;
    const make = o.make || o.make_name || v.make;
    const model = o.model || o.model_name || v.model;
    if (vin && (make || model) && !out.has(vin)) {
      out.set(vin, {
        vin, year: o.year || v.year || o.model_year, make: make || v.make, model: model || v.model,
        trim: o.trim || v.trim || o.series || o.trim_name || '',
        miles: o.odometer || v.odometer || o.mileage || o.miles || '',
        price: o.buy_now_price || o.buyNowPrice || o.current_bid || o.price || o.list_price || '',
        location: (o.location && (o.location.city || o.location.name)) || o.city || o.seller_city || '',
      });
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') scan(o[k]);
  };
  for (const e of events) if (e.kind === 'network' && typeof e.body === 'string' && e.body.length > 2) { try { scan(JSON.parse(e.body)); } catch {} }
  return [...out.values()];
}
function eventBadges(ev) {
  const out = [];
  if (ev.kind === 'network' && ev.body) {
    const f = ev.body;
    const vin = (f.match(/"(?:vin|vehicleIdentificationNumber)"\s*:\s*"([A-HJ-NPR-Z0-9]{11,17})"/i) || [])[1];
    const year = (f.match(/"year"\s*:\s*"?((?:19|20)\d\d)/i) || [])[1];
    const price = (f.match(/"(?:price|buy_now_price|list_price|current_bid)"\s*:\s*"?\$?([\d,]{3,})/i) || [])[1];
    if (vin) out.push('VIN ' + vin); if (year) out.push('Year ' + year); if (price) out.push('$' + price);
  }
  return out;
}

export default {
  id: 'research',
  name: 'Deep Research',
  description: 'Let any authorized agent read/navigate/control and record a chosen set of research tabs, and query what was captured.',
  artifacts: { sources: [], destinations: [{ id: DEST, name: 'Research Enabled Tabs', kind: 'dynamic', patterns: [] }] },
  baseRules: [{ id: 'research-base', source: 'Any Agent', destination: DEST, permissions: ['read', 'write', 'control', 'record'] }],
  navLinks: [{ label: 'Deep Research', href: '/modules/research' }],

  onEnable(ctx) {
    const existing = research(ctx).destinations && research(ctx).destinations[DEST];
    if (!existing) ctx.setDestinationContents('research', DEST, ['*']);
  },

  tools: {
    research_list_recordings: {
      description: 'List Deep Research recording sessions (id, tab title/url, event count, size, whether recording).',
      inputSchema: { type: 'object', properties: {} },
      async handler(_a, ctx) { return ctx.monitor.listSessions().map((s) => ({ id: s.id, root: s.root, tabId: s.tabId, title: s.title, url: s.url, events: s.count, bytes: s.bytes, active: s.active })); },
    },
    research_extract: {
      description: "Extract vehicle records (VIN, year, make/model, trim, miles, price, location) from a session's captured network bodies. Pass session id (root:name) or omit for the most recent.",
      inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
      async handler(args, ctx) {
        const ss = ctx.monitor.listSessions();
        const sel = args.session ? ss.find((s) => s.id === args.session || s.name === args.session) : ss[0];
        if (!sel) return { error: 'no session found' };
        const { events } = ctx.monitor.readEvents(sel.name, sel.root, 0);
        return { session: sel.id, title: sel.title, count: events.length, vehicles: extractVehicles(events) };
      },
    },
  },

  ui: {
    path: '/modules/research',
    async handler(req, res, url, ctx, h) {
      if (req.method === 'POST') {
        const { form } = await h.readBody(req);
        const a = form.action;
        const back = form.back || '/modules/research?tab=config';
        // Recording (per-tab + global).
        if (a === 'record') { try { await ctx.relayCommand('monitor.start', { tabId: Number(form.tabId) }); } catch {} return h.redirect(res, back); }
        if (a === 'stoprec') { try { await ctx.relayCommand('monitor.stop', { tabId: Number(form.tabId) }); } catch {} return h.redirect(res, back); }
        if (a === 'recordall' || a === 'stopall') {
          try {
            const tabs = (await ctx.relayCommand('tabs.list')) || [];
            if (a === 'recordall') { for (const t of tabs) { if (/^https?:/.test(t.url || '') && allowed(ctx, new URL(t.url).origin)) { try { await ctx.relayCommand('monitor.start', { tabId: t.tabId }); } catch {} } } }
            else { const live = (await ctx.relayCommand('monitor.list')) || []; for (const m of live) { try { await ctx.relayCommand('monitor.stop', { tabId: m.tabId }); } catch {} } }
          } catch {}
          return h.redirect(res, back);
        }
        // Access (per-tab + global).
        if (a === 'setglobalaccess') { ctx.setDestinationContents('research', DEST, form.on === '1' ? ['*'] : []); return h.redirect(res, back); }
        if (a === 'toggleaccess') {
          const origin = String(form.origin || '');
          let c = contentsOf(ctx);
          if (c.includes('*')) {
            // Converting from "all": keep every currently-open origin except this one.
            const tabs = (await ctx.relayCommand('tabs.list').catch(() => [])) || [];
            const origins = [...new Set(tabs.map((t) => { try { return new URL(t.url).origin; } catch { return null; } }).filter((o) => o && /^https?:/.test(o)))];
            c = origins.filter((o) => o !== origin);
          } else if (allowed(ctx, origin)) { c = c.filter((x) => x !== origin && !(x.startsWith('*.') && (hostOf(origin) === x.slice(2) || hostOf(origin).endsWith(x.slice(1))))); }
          else { c = [...c, origin]; }
          ctx.setDestinationContents('research', DEST, c);
          return h.redirect(res, back);
        }
        if (a === 'addpreset') { const cur = contentsOf(ctx).filter((x) => x !== '*'); const pat = String(form.pattern || ''); if (pat && !cur.includes(pat)) cur.push(pat); ctx.setDestinationContents('research', DEST, cur); return h.redirect(res, back); }
        // Storage (per-tab override + global default).
        if (a === 'setglobalstorage') { research(ctx).storageDefault = form.value === 'perm' ? 'perm' : 'tmp'; research(ctx).storage = {}; ctx.save(); return h.redirect(res, back); }
        if (a === 'togglestorage') { const origin = String(form.origin || ''); setStorageOverride(ctx, origin, effStorage(ctx, origin) === 'perm' ? 'tmp' : 'perm'); return h.redirect(res, back); }
        // Session mgmt from Activity.
        if (a === 'delsession' || a === 'movesession') {
          const sid = String(form.sid || ''); const i = sid.indexOf(':'); const root = sid.slice(0, i); const name = sid.slice(i + 1);
          if (a === 'delsession') ctx.monitor.deleteSession(name, root); else ctx.monitor.moveSession(name, root, root === 'perm' ? 'tmp' : 'perm');
          return h.redirect(res, '/modules/research?tab=activity');
        }
        return h.redirect(res, back);
      }

      const active = url.searchParams.get('tab') || 'config';
      const tabs = [{ id: 'config', label: 'Config' }, { id: 'activity', label: 'Activity' }];
      const body = active === 'activity' ? activityBody(url, ctx, h) : await configBody(ctx, h);
      h.htmlRes(res, h.moduleShell(h.mod, { tabs, active, header: 'Let authorized agents read/navigate/control and record your research tabs.', body }));
    },
  },
};

// --- Config tab: per-tab matrix + global row ---------------------------------
async function configBody(ctx, h) {
  let openTabs = [];
  try { openTabs = await ctx.relayCommand('tabs.list'); } catch {}
  let recording = new Set();
  try { recording = new Set(((await ctx.relayCommand('monitor.list')) || []).map((m) => m.tabId)); } catch {}
  const httpTabs = (openTabs || []).filter((t) => /^https?:/.test(t.url || ''));
  const gAll = globalAll(ctx);
  const gStore = storageDefault(ctx);

  // Action buttons (presets) vs. toggle switches (the matrix).
  const btn = (action, extra, label) => `<form method=POST style="display:inline"><input type=hidden name=action value="${action}">${Object.entries(extra).map(([k, v]) => `<input type=hidden name="${k}" value="${h.esc(v)}">`).join('')}<button>${label}</button></form>`;
  const toggle = (action, extra, on, cls = '') => `<form method=POST style="margin:0;display:inline-block;vertical-align:middle"><input type=hidden name=action value="${action}">${Object.entries(extra).map(([k, v]) => `<input type=hidden name="${k}" value="${h.esc(v)}">`).join('')}<label class="switch ${cls}"><input type=checkbox ${on ? 'checked' : ''} onchange="this.form.submit()"><span class="slider"></span></label></form>`;
  const disSwitch = (on) => `<label class="switch"><input type=checkbox ${on ? 'checked' : ''} disabled><span class="slider"></span></label>`;
  const storLbl = (perm) => `<span class="mut" style="font-size:11px;margin-left:6px">${perm ? 'Perm' : 'Tmp'}</span>`;
  const anyRec = recording.size > 0;

  const preset = PRESETS.map((p) => btn('addpreset', { pattern: p.pattern }, h.esc(p.label) + (contentsOf(ctx).includes(p.pattern) ? ' ✓' : ''))).join(' ');

  const globalRow = `<tr style="background:#181b21">
    <td><b>All tabs</b> <span class="mut" style="font-size:11px">· default for new tabs</span></td>
    <td>${toggle('setglobalaccess', { on: gAll ? '0' : '1' }, gAll)}</td>
    <td>${toggle('setglobalstorage', { value: gStore === 'perm' ? 'tmp' : 'perm' }, gStore === 'perm')}${storLbl(gStore === 'perm')}</td>
    <td>${toggle(anyRec ? 'stopall' : 'recordall', {}, anyRec, 'rec')}<span class="mut" style="font-size:11px;margin-left:6px">all</span></td></tr>`;

  const rows = httpTabs.map((t) => {
    let origin = ''; try { origin = new URL(t.url).origin; } catch {}
    const acc = allowed(ctx, origin);
    const st = effStorage(ctx, origin);
    const rec = recording.has(t.tabId);
    const fav = t.favIconUrl ? `<img src="${h.esc(t.favIconUrl)}" style="width:15px;height:15px;border-radius:3px;vertical-align:middle;margin-right:6px" onerror="this.style.display='none'">` : '';
    return `<tr>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fav}${h.esc(t.title || origin)}</td>
      <td>${gAll ? disSwitch(true) + '<span class="mut" style="font-size:11px;margin-left:6px">via All</span>' : toggle('toggleaccess', { origin }, acc)}</td>
      <td>${toggle('togglestorage', { origin }, st === 'perm')}${storLbl(st === 'perm')}</td>
      <td>${toggle(rec ? 'stoprec' : 'record', { tabId: t.tabId }, rec, 'rec')}</td></tr>`;
  }).join('') || '<tr><td colspan=4 class="mut">No http(s) tabs open.</td></tr>';

  return `
    <div class="card"><b>Quick add research sites</b><div class="row" style="margin-top:8px">${preset}</div>
      <div class="mut" style="font-size:12px;margin-top:6px">Adds a durable host pattern (e.g. <code>*.autotrader.com</code>). Turn <b>All tabs → Access</b> off to control tabs individually.</div></div>
    <div class="card"><table>
      <thead><tr><th>Tab</th><th>Access</th><th>Storage</th><th>Record</th></tr></thead>
      <tbody>${globalRow}${rows}</tbody></table>
      <div class="mut" style="font-size:12px;margin-top:8px">Access = which tabs agents may act on. Storage = where a tab's recording is saved. Record = start/stop capturing a tab. The <b>All tabs</b> row applies to every tab and sets the default for new ones.</div>
    </div>`;
}

// --- Activity tab: native recordings view ------------------------------------
function activityBody(url, ctx, h) {
  const sessions = ctx.monitor.listSessions();
  const sel = sessions.find((s) => s.id === url.searchParams.get('session')) || null;
  const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; };
  const fmtTime = (ts) => { if (!ts) return ''; try { const d = new Date(ts); return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString(); } catch { return ''; } };
  const list = sessions.length ? sessions.map((s) => {
    const label = s.title || s.url || ('tab ' + (s.tabId ?? '?'));
    const fav = s.favIconUrl ? `<img src="${h.esc(s.favIconUrl)}" style="width:14px;height:14px;border-radius:3px" onerror="this.style.display='none'">` : '';
    return `<a href="/modules/research?tab=activity&session=${encodeURIComponent(s.id)}" class="sessrow${sel && sel.id === s.id ? ' on' : ''}">
      <div style="display:flex;align-items:center;gap:6px">${s.active ? '🔴 ' : ''}${fav}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.esc(label)}</span><span class="tag ${s.root === 'perm' ? 'on' : 'off'}">${s.root}</span></div>
      <div class="mut" style="font-size:11px">${s.count} events · ${fmtBytes(s.bytes)}</div></a>`;
  }).join('') : '<div class="mut" style="padding:8px">No recordings yet.</div>';

  let feed = '<div class="mut" style="padding:12px">Select a recording.</div>';
  if (sel) {
    const { events } = ctx.monitor.readEvents(sel.name, sel.root, 0);
    const recent = events.slice(-80);
    const items = recent.map((ev) => {
      let ico = '•', main = ev.url || '';
      if (ev.kind === 'navigation') ico = '🧭'; else if (ev.kind === 'network') { ico = '🌐'; main = (ev.status ? ev.status + ' ' : '') + (ev.url || ''); } else if (ev.kind === 'screenshot') ico = '🖼'; else if (ev.kind === 'session') { ico = '⚑'; main = 'session ' + (ev.event || ''); }
      const badges = eventBadges(ev).map((b) => `<span class="tag">${h.esc(b)}</span>`).join(' ');
      const n = ev.kind === 'screenshot' ? shotNum(ev.file) : null;
      const shot = n ? `<img class="shot" loading=lazy src="/monitor/shot?key=${encodeURIComponent(sel.name)}&root=${encodeURIComponent(sel.root)}&n=${n}">` : '';
      return `<div class="ev"><div style="width:20px">${ico}</div><div style="flex:1;min-width:0"><div style="word-break:break-all;font-size:12px">${h.esc(main)}</div><div class="mut" style="font-size:11px">${fmtTime(ev.ts)}${ev.kind ? ' · ' + h.esc(ev.kind) : ''}</div>${badges ? `<div style="margin-top:3px">${badges}</div>` : ''}${shot}</div></div>`;
    }).join('');
    feed = `<div class="row" style="margin-bottom:8px"><b style="flex:1">${h.esc(sel.title || sel.name)}</b>
      <form method=POST style="display:inline"><input type=hidden name=action value=movesession><input type=hidden name=sid value="${h.esc(sel.id)}"><button>Move → ${sel.root === 'perm' ? 'Tmp' : 'Perm'}</button></form>
      <form method=POST onsubmit="return confirm('Delete this recording?')" style="display:inline"><input type=hidden name=action value=delsession><input type=hidden name=sid value="${h.esc(sel.id)}"><button class=bad>Delete</button></form></div>
      <div class="mut" style="font-size:11px;margin-bottom:6px">Showing last ${recent.length} of ${events.length} events</div>${items}`;
  }
  return `<style>
    .actwrap{display:flex;gap:14px;align-items:flex-start}
    .sesslist{width:260px;flex:none;max-height:calc(100vh - 220px);overflow:auto}
    a.sessrow{display:block;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;text-decoration:none;color:var(--fg)}
    a.sessrow:hover{background:var(--card)} a.sessrow.on{border-color:var(--accent)}
    .feed{flex:1;min-width:0;max-height:calc(100vh - 220px);overflow:auto;border:1px solid var(--line);border-radius:10px;padding:12px}
    .ev{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)}
    img.shot{max-width:320px;border:1px solid var(--line);border-radius:6px;margin-top:5px;display:block}
  </style>
  <div class="actwrap"><div class="sesslist">${list}</div><div class="feed">${feed}</div></div>`;
}
