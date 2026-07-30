// modules/research.mjs — the Deep Research capability (car / real-estate).
// Config = a per-tab matrix (Access / Storage / Record) with a global row that
// toggles ALL tabs and sets the default for new tabs. Activity = native
// recordings view. Plus tools to query what was recorded.

import { join } from 'node:path';

const DEST = 'research-tabs';

// Absolute on-disk dir for a session, so an agent with filesystem access can read the
// raw capture (full network bodies, all screenshots) instead of the summarized view.
function sessionDir(ctx, s) {
  try { return join(ctx.monitor.MON_ROOTS[s.root], s.name); } catch { return null; }
}

const PRESETS = [
  { label: 'AutoTrader', pattern: '*.autotrader.com' },
  { label: 'ACV Auctions', pattern: '*.acvauctions.com' },
  { label: 'Cars.com', pattern: '*.cars.com' },
  { label: 'CarGurus', pattern: '*.cargurus.com' },
  { label: 'Zillow', pattern: '*.zillow.com' },
  { label: 'Redfin', pattern: '*.redfin.com' },
];

// Verdict vocabulary + colors, kept identical to the toolkit's own reports
// (src/report-jeep.ts) so an overlay badge reads the same as the tracker.
// `mute` = dim + strike the card, so the user visually skips it.
const VERDICT = {
  review: { label: '✅ REVIEW', color: '#3fb950', mute: false },
  maybe: { label: '🟡 MAYBE', color: '#d29922', mute: false },
  pass: { label: '🔴 PASS', color: '#f85149', mute: true },
};

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
// Turn a session's raw events into a compact, agent-readable review: counts, the
// navigation trail, recent network calls (with a short JSON body preview), and the
// screenshot numbers to fetch via research_view_screenshot.
function summarizeRecording(sel, events, limit) {
  const preview = (body) => {
    if (typeof body !== 'string' || !body) return undefined;
    try { const s = JSON.stringify(JSON.parse(body)); return s.length > 300 ? s.slice(0, 300) + '…' : s; }
    catch { return body.length > 200 ? body.slice(0, 200) + '…' : body; }
  };
  const navigations = events.filter((e) => e.kind === 'navigation').map((e) => ({ ts: e.ts, url: e.url }));
  const network = events.filter((e) => e.kind === 'network').map((e) => ({ ts: e.ts, method: e.method || 'GET', status: e.status, url: e.url, body: preview(e.body) }));
  const screenshots = events.filter((e) => e.kind === 'screenshot').map((e) => Number(shotNum(e.file))).filter((n) => Number.isFinite(n));
  // Marks the USER made on the page via the overlay badge (Pass / Watch / Note).
  // These are decisions to act on, so they are never truncated by `limit`.
  const marks = events.filter((e) => e.kind === 'annotation')
    .map((e) => ({ ts: e.ts, key: e.key, action: e.action, reason: e.reason || '', url: e.url || '' }));
  const counts = { navigations: navigations.length, network: network.length, screenshots: screenshots.length, marks: marks.length, total: events.length };
  const hints = [];
  if (marks.length) hints.push(`The USER marked ${marks.length} item(s) in-page (see userMarks) — record those decisions in your own list and re-annotate.`);
  if (screenshots.length) hints.push(`Call research_view_screenshot with session "${sel.id}" and a screenshot number to see the page.`);
  return {
    session: sel.id, title: sel.title, url: sel.url, recording: sel.active, tabId: sel.tabId, dir: sel.dir || null, counts,
    note: sel.dir ? `Network bodies below are truncated to ~300 chars. Full capture: ${sel.dir}/events.jsonl` : undefined,
    userMarks: marks,
    navigations: navigations.slice(-limit),
    network: network.slice(-limit),
    screenshots,
    hint: hints.join(' ') || 'Nothing captured yet.',
  };
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
  version: '0.1.0',
  description: 'Let any authorized agent read/navigate/control and record a chosen set of research tabs, and query what was captured.',
  autoEnable: true, // go live on first install without a manual toggle (one-time; a later manual disable sticks)
  artifacts: { sources: [], destinations: [{ id: DEST, name: 'Research Enabled Tabs', kind: 'dynamic', patterns: [] }] },
  // Rule id is versioned: setEnabled only adds rules whose id isn't already present,
  // so bumping it is how an existing install picks up a NEW permission verb. The old
  // `research-base` rule can stay — evaluate() skips rules that don't list the verb
  // being checked, so `annotate` falls through to this one.
  baseRules: [{ id: 'research-base-v2', source: 'Any Agent', destination: DEST, permissions: ['read', 'write', 'control', 'record', 'annotate'] }],
  navLinks: [{ label: 'Deep Research', href: '/modules/research' }],

  // Contributed to the MCP server's `instructions` on connect, so an agent learns this
  // workflow without the user pasting a prompt.
  instructions: (ctx) => `Annotate what the user is browsing so they don't re-evaluate the same vehicles.

Loop (roughly every 10-20s while they browse):
1. browser_tabs_list -> the active research tab. (research_list_recordings if a tab is being recorded.)
2. See what's on screen: browser_read for page text, or research_extract for structured vehicles when the tab IS recorded (cleaner). Recording is OPTIONAL — annotating works either way.
3. research_annotate_vehicles({tabId, vehicles:[{vin|auctionId, verdict, score?, note?}]}) for every vehicle you ALREADY have a judgment on. verdict "pass" dims + strikes the card, "maybe" is amber, "review" is green. Put your reasoning in note — it becomes the hover text.
4. browser_annotate_list to confirm which keys matched on the page.
5. research_user_marks({since:<newestTs>}) to collect the user's Pass/Watch/Note clicks. Record each decision in your own list, re-annotate, and pass newestTs back next poll or you'll reprocess them.

Key facts:
- ACV Auctions never renders the VIN — match by auctionId (it's in the listing links/URL). Pass both vin and auctionId when known; the mark key comes back as VIN@auctionId.
- This bridge stores NOTHING. It only draws what you send. Keep the durable per-vehicle record yourself and persist after every decision. Annotations survive navigation, SPA routes and infinite scroll, but die when the browser closes — re-annotate from your list at the start of a session.
- Only annotate what you actually know; no badge is better than a guessed one. If history isn't pulled, say so rather than implying a clean record.
- ACV is read-only and low volume. Never bid.

WHERE RECORDINGS LIVE ON DISK (only if you have filesystem access — otherwise use the tools):
${(() => { try { const r = ctx.monitor.MON_ROOTS; return `  temporary: ${r.tmp}\n  permanent: ${r.perm}`; } catch { return '  (unavailable)'; } })()}
Each session is a directory named <root>/<sessionName> containing:
  events.jsonl   one JSON event per line: {kind:"network"|"navigation"|"screenshot"|"session"|"annotation", ts, ...}. Network events carry the FULL response body.
  screenshots/   00001.jpg, 00002.jpg, ...
  meta.json      title, favicon, url, counts
research_list_recordings returns the absolute \`dir\` for each session, so read it from there rather than guessing.
IMPORTANT: research_read_recording TRUNCATES network bodies to ~300 chars and caps entries by \`limit\`. When you need complete payloads (e.g. to pull every VIN out of a listing API response), read events.jsonl directly and parse the full \`body\` field. Tail it for a live feed.`,

  onEnable(ctx) {
    // Deny-by-default: a fresh enable grants access to NO tabs. The user opts tabs in
    // at /modules/research (Config) — per-tab toggles, site presets, or "All tabs".
    // (An existing install keeps whatever the user already chose.)
    const existing = research(ctx).destinations && research(ctx).destinations[DEST];
    if (!existing) ctx.setDestinationContents('research', DEST, []);
  },

  tools: {
    research_list_recordings: {
      description: [
        'STEP 1 for reviewing a recorded page. Lists recording sessions (a "recording" = everything captured while a tab was recorded: navigations, network responses, screenshots).',
        '',
        'Each entry gives the session `id` (pass it to research_read_recording / research_view_screenshot), `tabId`, title/url, event count, whether it is still `recording`, and `dir` — the ABSOLUTE on-disk directory.',
        '',
        'If you have filesystem access, read `dir`/events.jsonl for the raw capture: one JSON event per line with FULL network response bodies (research_read_recording truncates them to ~300 chars). Screenshots are `dir`/screenshots/NNNNN.jpg. Tail events.jsonl for a live feed.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: {} },
      async handler(_a, ctx) {
        const roots = (() => { try { return ctx.monitor.MON_ROOTS; } catch { return {}; } })();
        return {
          storage: { tmp: roots.tmp || null, perm: roots.perm || null, layout: '<dir>/events.jsonl · <dir>/screenshots/NNNNN.jpg · <dir>/meta.json' },
          sessions: ctx.monitor.listSessions().map((s) => ({
            id: s.id, tabId: s.tabId, title: s.title, url: s.url,
            events: s.count, recording: s.active, dir: sessionDir(ctx, s),
          })),
        };
      },
    },
    research_read_recording: {
      description: 'STEP 2: review what was captured in a recording. Returns the timeline — page navigations, network requests (method/status/url with a short JSON body preview), and the list of screenshot numbers. Pass a session id from research_list_recordings, or omit for the most recent. Then call research_view_screenshot to SEE any screenshot.',
      inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'session id from research_list_recordings; omit for most recent' }, limit: { type: 'integer', description: 'max timeline entries (default 100, newest kept)' } } },
      async handler(args, ctx) {
        const ss = ctx.monitor.listSessions();
        const sel = args.session ? ss.find((s) => s.id === args.session || s.name === args.session) : ss[0];
        if (!sel) return { error: 'no recording found. Record a tab first (Deep Research config, or the extension popup "Record this tab").' };
        const { events } = ctx.monitor.readEvents(sel.name, sel.root, 0);
        return summarizeRecording({ ...sel, dir: sessionDir(ctx, sel) }, events, args.limit || 100);
      },
    },
    research_view_screenshot: {
      description: 'Return a captured screenshot from a recording AS AN IMAGE so you can see the page. Pass the session id and the screenshot number (from research_read_recording); omit number for the latest screenshot in that session.',
      inputSchema: { type: 'object', properties: { session: { type: 'string' }, number: { type: 'integer', description: 'screenshot number; omit for the latest' } }, required: ['session'] },
      async handler(args, ctx) {
        const ss = ctx.monitor.listSessions();
        const sel = ss.find((s) => s.id === args.session || s.name === args.session) || (!args.session ? ss[0] : null);
        if (!sel) return { error: 'no such session' };
        let n = args.number;
        if (n == null) { const { events } = ctx.monitor.readEvents(sel.name, sel.root, 0); const shots = events.filter((e) => e.kind === 'screenshot').map((e) => shotNum(e.file)).filter(Boolean); n = shots[shots.length - 1]; }
        if (n == null) return { error: 'this recording has no screenshots' };
        const img = ctx.monitor.readShot(sel.name, sel.root, n);
        if (!img) return { error: `screenshot ${n} not found in ${sel.id}` };
        return { __mcpContent: [{ type: 'image', data: img.base64, mimeType: img.mime }] };
      },
    },
    research_user_marks: {
      description: [
        'Poll this in a monitoring loop: returns every Pass / Watch / Note the USER clicked on an annotation badge, across all recordings, newest first.',
        '',
        'This is how the user tells you a decision while browsing. Each mark has the `key` you annotated with (e.g. the VIN), the `action` (pass|watch|note), the free-text `reason` they typed, the page `url`, its `tabId`, and `ts`.',
        '',
        'Record each decision in your own list, then re-annotate the tab so the new verdict shows. Use `since` (epoch ms) to fetch only marks newer than the last one you processed — otherwise you will see the same ones every poll.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'epoch ms — return only marks with ts greater than this (pass the newest ts you have already handled)' },
        },
      },
      async handler(args, ctx) {
        const since = Number(args.since) || 0;
        const out = [];
        // Live marks from the bridge's delivery queue — present whether or not the tab
        // is being recorded. This is the primary source.
        if (ctx.overlay && typeof ctx.overlay.marks === 'function') {
          for (const m of ctx.overlay.marks(since)) out.push({ ...m, session: null });
        }
        // Plus any marks already written into recordings (survive a bridge restart).
        for (const s of ctx.monitor.listSessions()) {
          // A session whose last event predates the cursor cannot contain a newer mark —
          // skip it instead of re-parsing its whole events.jsonl on every poll.
          const last = Number(s.lastEventAt) || 0;
          if (since > 0 && last && last <= since) continue;
          let ev = [];
          try { ev = ctx.monitor.readEvents(s.name, s.root, 0).events; } catch { continue; }
          for (const e of ev) {
            if (e.kind !== 'annotation') continue;
            if (!(Number(e.ts) > since)) continue;
            out.push({ ts: e.ts, key: e.key, action: e.action, reason: e.reason || '', url: e.url || '', tabId: s.tabId, session: s.id });
          }
        }
        // De-dupe: a mark on a recorded tab arrives from both sources.
        const seen = new Set();
        const uniq = [];
        for (const m of out) {
          const k = m.ts + '|' + m.key + '|' + m.action;
          if (seen.has(k)) continue;
          seen.add(k); uniq.push(m);
        }
        out.length = 0; out.push(...uniq);
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return {
          marks: out.slice(0, 200),
          count: out.length,
          newestTs: out.length ? out[0].ts : since,
          hint: out.length
            ? 'Save these decisions in your own list, then call research_annotate_vehicles again so the page reflects them. Pass newestTs back as `since` next poll.'
            : 'No new marks. Poll again with the same `since`.',
        };
      },
    },
    research_annotate_vehicles: {
      description: [
        'Mark up vehicles ON THE PAGE THE USER IS BROWSING with what you already know — a badge per vehicle, your reasoning on hover, and passed ones dimmed + struck through so the user stops clicking them.',
        '',
        'YOU supply the list; this module stores nothing. Typical loop: read the recording (research_read_recording / research_extract) to see which vehicles the user is looking at, compare against your own table, then call this with a row per vehicle you recognize.',
        '',
        'Identify each vehicle by `vin` (matched against the page text) OR by `auctionId` for ACV Auctions, which never renders the VIN — the auction id is matched against listing links instead. Pass both if you have them.',
        '',
        'verdict controls the styling: "pass" = red, dimmed + struck; "maybe" = amber; "review" = green. Put your reasoning in `note` — it becomes the hover text.',
        '',
        'Example: [{"vin":"1C4BJWFG7FL620087","verdict":"pass","score":42,"note":"Canadian import · rust risk\\nPriced 14% above comps"}]',
        '',
        'Annotations persist across navigation and infinite scroll until the browser closes. The tab must be in Research Enabled Tabs.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'tab to annotate (from browser_tabs_list)' },
          vehicles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                vin: { type: 'string', description: '17-char VIN; matched against page text' },
                auctionId: { type: 'string', description: 'ACV auction id; matched against links (use when the VIN is not on screen)' },
                verdict: { type: 'string', enum: ['pass', 'maybe', 'review'], description: 'drives color + dim/strike' },
                score: { type: 'number', description: 'optional, shown on the badge' },
                note: { type: 'string', description: 'your reasoning — shown on hover' },
                label: { type: 'string', description: 'optional badge text override' },
              },
            },
          },
          merge: { type: 'boolean', description: 'keep existing annotations on the tab (default true)' },
        },
        required: ['tabId', 'vehicles'],
      },
      async handler(args, ctx) {
        const tabId = Number(args.tabId);
        if (!Number.isFinite(tabId)) return { error: 'tabId (number) is required' };
        // Module tools are NOT gated by the rule engine (see mcp.mjs), so gate here
        // with the same predicate the rest of this module uses.
        let url = '';
        try { url = (await ctx.resolveTabUrl(tabId)) || ''; } catch { /* fall through */ }
        if (!/^https?:/i.test(url)) return { error: `tab ${tabId} is not an http(s) tab` };
        let origin = ''; try { origin = new URL(url).origin; } catch {}
        if (!allowed(ctx, origin)) {
          return { error: `${origin} is not in Research Enabled Tabs — enable it at /modules/research (Config tab) first.` };
        }
        const list = Array.isArray(args.vehicles) ? args.vehicles : [];
        if (!list.length) return { error: 'vehicles[] is empty — nothing to annotate' };

        const rules = [];
        for (const v of list) {
          const vin = typeof v.vin === 'string' ? v.vin.trim().toUpperCase() : '';
          const aid = v.auctionId != null ? String(v.auctionId).trim() : '';
          if (!vin && !aid) continue;
          const verdict = VERDICT[v.verdict] || VERDICT.maybe;
          const score = Number.isFinite(v.score) ? ' · ' + v.score : '';
          const label = typeof v.label === 'string' && v.label ? v.label : verdict.label + score;
          const badge = { label, color: verdict.color, tooltip: v.note || label };
          const card = verdict.mute ? { dim: true, strike: true } : undefined;
          // VIN is matched in the page text; ACV auction ids live in listing hrefs.
          if (vin) rules.push({ key: vin, match: { text: vin }, badge, card });
          if (aid) rules.push({ key: vin ? vin + '@' + aid : aid, match: { href: '/' + aid }, badge, card });
        }
        if (!rules.length) return { error: 'no vehicle had a vin or auctionId' };

        try {
          const r = await ctx.relayCommand('overlay.set', { tabId, rules, merge: args.merge !== false });
          return {
            annotated: rules.length, tab: url, rules: r && r.rules,
            hint: 'Call browser_annotate_list to see which matched on screen, or browser_screenshot to look at it.',
          };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    },
    research_extract: {
      description: "Extract vehicle records (VIN, year, make/model, trim, miles, price, location) from a recording's captured network bodies. Pass session id (from research_list_recordings) or omit for the most recent.",
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

  // Focused-tab actions surfaced in the extension popup. `record` uses the built-in
  // 'recording' capability; `annotations` is handled by onTabAction below so the user
  // can hide/show the agent's notes on the tab they're looking at.
  tabActions: [
    { id: 'record', uses: 'recording', match: '*', labels: { off: '⏺ Record this tab', on: '⏹ Stop recording this tab' } },
    { id: 'annotations', match: '*', labels: { off: '🏷 Show agent notes', on: '🏷 Hide agent notes' } },
  ],

  // On = the tab currently has annotations drawn on it.
  async tabActionState(id, { tabId }, ctx) {
    if (id !== 'annotations') return false;
    try { const r = await ctx.relayCommand('overlay.list', { tabId: Number(tabId) }); return !!(r && r.keys && r.keys.length); }
    catch { return false; }
  },

  // Toggling only CLEARS (hides) — re-drawing is the agent's job, since the bridge
  // stores no notes of its own. Stashing the cleared set would make this a store.
  async onTabAction(id, { tabId }, ctx) {
    if (id !== 'annotations') return { ok: false, error: 'unknown action' };
    const tid = Number(tabId);
    const cur = await ctx.relayCommand('overlay.list', { tabId: tid }).catch(() => null);
    if (cur && cur.keys && cur.keys.length) {
      await ctx.relayCommand('overlay.clear', { tabId: tid });
      return { ok: true, on: false, note: 'Notes hidden. Ask the agent to annotate again to bring them back.' };
    }
    return { ok: true, on: false, note: 'No agent notes on this tab yet — ask the agent to annotate it.' };
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
