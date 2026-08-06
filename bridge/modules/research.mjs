// modules/research.mjs — Deep Research, as a 2.0 automation module.
//
// This used to be the module that GAVE agents their capabilities: it owned the tab
// permission list, seeded the rules that allowed read/write/control/record/annotate,
// and served a pile of research_* MCP tools. All of that is bridge core now — agents
// get every primitive directly, and which tabs they may touch lives at /tabs.
//
// What's left is what a 2.0 module actually is: an automation that runs inside the
// bridge on a schedule with no agent present, plus a page for looking at what it
// captured. It ships with NO schedule, so it does nothing until you either press
// "Run now" or add a `schedule` — opening six tabs unannounced is not a good default.

const shotNum = (file) => { const m = /(\d+)\.(?:jpg|png)$/.exec(file || ''); return m ? m[1] : null; };

// The sites this automation opens. Only the ones you've enabled under Tabs are
// actually reachable — the rest are refused and reported, not silently skipped.
const SITES = [
  'https://www.autotrader.com',
  'https://www.acvauctions.com',
  'https://www.zillow.com',
];

export default {
  id: 'research',
  name: 'Deep Research',
  version: '2.0.0',
  description: 'Opens your research sites, waits for you to sign in, then records them for later review.',
  autoEnable: true,

  // No schedule by default. Add one to make it run on its own, e.g.
  //   schedule: { at: '09:00', days: ['MON','TUE','WED','THU','FRI'] },
  schedule: null,

  // The time would be the trigger; this says the run waits until someone is actually
  // at the browser, because the sites below need a signed-in session.
  authRequired: true,

  actions: ['control', 'read', 'record'],

  // The tray's "open dashboard" lands here: the live capture view, which is what
  // someone clicking the tray while recording actually wants to see.
  dashboard: '/modules/research',
  navLinks: [{ label: 'Deep Research', href: '/modules/research' }],

  async run(ctx) {
    const opened = [];
    const refused = [];
    for (const url of SITES) {
      try { opened.push({ url, tabId: (await ctx.tabs.open(url)).tabId }); }
      catch (e) { refused.push({ url, why: (e && e.message) || String(e) }); }
    }
    if (refused.length) {
      ctx.log('refused:', refused.map((r) => r.url).join(', '));
      await ctx.notify(`Skipped ${refused.length} site(s) not enabled under Tabs.`);
    }
    if (!opened.length) ctx.fail('no-sites', 'no enabled sites to open — enable them at /tabs');

    // Pause here rather than recording a login wall and calling it a success.
    await ctx.needsAuth(opened.map((o) => o.tabId), 'Sign in to your research sites, then this will start recording.');

    for (const o of opened) {
      try { await ctx.record.start(o.tabId); } catch (e) { ctx.log('could not record', o.url, e && e.message); }
    }
    ctx.store.set('lastOpened', opened.map((o) => o.url));
    await ctx.notify(`Recording ${opened.length} tab(s). Stop them from the Tabs page.`);
  },

  ui: {
    path: '/modules/research',
    async handler(req, res, url, ctx, h) {
      if (req.method === 'POST') {
        const { form } = await h.readBody(req);
        if (form.action === 'delsession' || form.action === 'movesession') {
          const sid = String(form.sid || ''); const i = sid.indexOf(':');
          const root = sid.slice(0, i), name = sid.slice(i + 1);
          if (form.action === 'delsession') ctx.monitor.deleteSession(name, root);
          else ctx.monitor.moveSession(name, root, root === 'perm' ? 'tmp' : 'perm');
        }
        return h.redirect(res, '/modules/research');
      }
      h.htmlRes(res, h.moduleShell(h.mod, {
        header: 'What this automation captured. Which tabs it may touch is set under <a href="/tabs">Tabs</a>.',
        body: activityBody(url, ctx, h),
      }));
    },
  },
};

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

// --- Activity tab: native recordings view ------------------------------------
function activityBody(url, ctx, h) {
  const sessions = ctx.monitor.listSessions();
  const sel = sessions.find((s) => s.id === url.searchParams.get('session')) || null;
  const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; };
  const fmtTime = (ts) => { if (!ts) return ''; try { const d = new Date(ts); return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString(); } catch { return ''; } };
  const list = sessions.length ? sessions.map((s) => {
    const label = s.title || s.url || ('tab ' + (s.tabId ?? '?'));
    const fav = s.favIconUrl ? `<img src="${h.esc(s.favIconUrl)}" style="width:14px;height:14px;border-radius:3px" onerror="this.style.display='none'">` : '';
    return `<a href="/modules/research?session=${encodeURIComponent(s.id)}" class="sessrow${sel && sel.id === s.id ? ' on' : ''}">
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
