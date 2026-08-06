// automation.mjs — the scheduler that makes a module useful with no agent present.
//
// A 2.0 module is an automation: "every weekday at 9am, once someone is actually at the
// browser, open these three tabs, let me sign in, then scrape." Two distinct ideas there,
// and conflating them is what makes naive schedulers annoying:
//
//   TRIGGER = time of day. It fires whether or not anyone is around.
//   GATE    = browser activity. `authRequired: true` means the run is ARMED at 09:00 and
//             HELD until the extension reports a human is there; then it proceeds. So a
//             run scheduled for 09:00 on a laptop opened at 09:41 runs at 09:41 — not
//             skipped, not fired into a dark browser where the auth prompt goes unseen.
//
// Everything is keyed on a per-window fire key (module + local date + HH:MM), persisted
// in state.moduleRuns. That's what makes a restart safe: a bridge that restarts at 09:15
// neither re-runs a window it already completed nor loses one it was still holding.

import { state, save } from './state.mjs';
import { listModules, getModule } from './modules.mjs';
import { urlAllowed, resolveTabUrl } from './tabaccess.mjs';

const TICK_MS = 30_000;
const DAY_ORDER = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// How long an armed-but-ungated run stays armed. Past this the window is abandoned:
// running yesterday's 9am scrape when the browser finally opens at 4pm is rarely what
// anyone meant, and silently doing it is worse than skipping it.
const ARM_TTL_MS = 8 * 60 * 60 * 1000;

let _ctx = null;          // module ctx (relayCommand, monitor, …)
let _timer = null;
let _lastActivity = 0;    // ms epoch of the most recent sign of a human at the browser
const running = new Set(); // moduleIds mid-run — one run per module at a time

export function configureAutomation(ctx) { _ctx = ctx; }

// Called by the server whenever the extension shows a human is present: a tab activated,
// a navigation committed, a recorded click. Any of these means the browser is in front of
// someone, which is all the gate needs to know.
export function noteBrowserActivity() { _lastActivity = Date.now(); }

// Activity is "recent" for a few minutes — a person who switched tabs 90 seconds ago is
// still at the keyboard, and demanding activity in the same 30s tick would make the gate
// depend on luck.
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
export function browserActive() { return Date.now() - _lastActivity < ACTIVITY_WINDOW_MS; }

function runs(id) {
  const all = state.moduleRuns || (state.moduleRuns = {});
  return all[id] || (all[id] = {});
}

// Identifies one scheduled window: "research@2026-08-06T09:00". Two ticks inside the same
// window produce the same key, which is exactly what stops a double-run.
function fireKey(id, at, d = new Date()) {
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${id}@${ymd}T${at}`;
}

// Exported for tests: the window arithmetic is the part that must not drift, and the
// only way to check "restart mid-window doesn't double-run" without waiting for 9am.
export function scheduleDue(mod, now = new Date()) {
  const s = mod.schedule;
  if (!s || !s.at) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.at));
  if (!m) return null;
  const days = Array.isArray(s.days) && s.days.length ? s.days.map((d) => String(d).toUpperCase()) : DAY_ORDER;
  if (!days.includes(DAY_ORDER[now.getDay()])) return null;
  const fireAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
  return now >= fireAt ? { key: fireKey(mod.id, s.at, now), fireAt: fireAt.getTime() } : null;
}

async function tick() {
  for (const meta of listModules()) {
    if (!meta.enabled) continue;
    const mod = getModule(meta.id);
    if (!mod || typeof mod.run !== 'function') continue;

    const due = scheduleDue(mod);
    if (!due) continue;

    const r = runs(mod.id);
    if (r.lastFireKey === due.key) continue;       // this window is done or in flight
    if (running.has(mod.id)) continue;

    if (mod.authRequired && !browserActive()) {
      // Armed, waiting for a human. Say so once per window so the panel can show it,
      // and give up if the window has gone stale.
      if (r.armedKey !== due.key) { r.armedKey = due.key; r.armedAt = Date.now(); save(); }
      if (Date.now() - due.fireAt > ARM_TTL_MS) {
        r.lastFireKey = due.key;
        r.lastRun = Date.now();
        r.lastError = 'skipped — nobody was at the browser during the scheduled window';
        r.armedKey = null; save();
      }
      continue;
    }

    // Claim the window BEFORE awaiting, so a slow run can't be started twice by the next
    // tick or by a restart that lands mid-run.
    r.lastFireKey = due.key;
    r.armedKey = null;
    save();
    runModule(mod, 'schedule').catch(() => {});
  }
}

export async function runModuleNow(id) {
  const mod = getModule(id);
  if (!mod) return { ok: false, error: 'no such module' };
  if (typeof mod.run !== 'function') return { ok: false, error: `${id} is not an automation — it has no run()` };
  return runModule(mod, 'manual');
}

async function runModule(mod, trigger) {
  if (running.has(mod.id)) return { ok: false, error: 'already running' };
  running.add(mod.id);
  const r = runs(mod.id);
  r.running = true; r.startedAt = Date.now(); r.trigger = trigger; save();
  try {
    await mod.run(moduleRunCtx(mod));
    r.lastError = null;
    return { ok: true };
  } catch (e) {
    r.lastError = (e && e.message) || String(e);
    return { ok: false, error: r.lastError };
  } finally {
    running.delete(mod.id);
    r.running = false; r.lastRun = Date.now(); save();
  }
}

export function isRunning(id) { return running.has(id); }
export function runningModules() { return [...running]; }

// --- The ctx a module's run() receives ---------------------------------------
// Deliberately the same primitives an agent gets over MCP, subject to the same tab
// access check — a module is not a privilege escalation path.
function moduleRunCtx(mod) {
  const log = (...a) => console.log(`[module:${mod.id}]`, ...a);
  const declared = new Set(Array.isArray(mod.actions) ? mod.actions : []);

  // Every module call goes through the SAME tab-access check an agent's MCP call does,
  // and through the module's own declared `actions`. A module is automation the user
  // approved, not a way around the setting they chose — without this, installing a
  // module would quietly grant more reach than any agent has.
  const relay = async (method, params, need) => {
    if (need && !declared.has(need)) {
      throw new Error(`${mod.id} used "${need}" without declaring it — add '${need}' to actions in the manifest`);
    }
    let url = null;
    if (params && typeof params.url === 'string') url = params.url;
    else if (params && typeof params.tabId === 'number') {
      url = await resolveTabUrl(params.tabId);
      // A tabId we cannot resolve must be REFUSED, not waved through. urlAllowed(null)
      // means "this call names no tab" (tabs.list, monitor.list) — reusing it for a tab
      // that isn't open would let any unknown id bypass the check entirely.
      if (!url) throw new Error(`refused: tab ${params.tabId} is not open, or is not one you may use`);
    }
    // Same per-site, per-capability check an agent gets. `need` is the capability, so a
    // module declaring only 'read' cannot reach control-level primitives even on a site
    // where the user granted control.
    const d = urlAllowed(url, need || 'read');
    if (!d.allow) throw new Error(`refused: ${d.reason}`);
    return _ctx.relayCommand(method, params);
  };

  return {
    id: mod.id,
    log,
    // fail(code, message) or fail(message) — the code lands in the run history so a
    // recurring failure is recognisable at a glance.
    fail: (code, message) => {
      const e = new Error(message == null ? String(code) : `${code}: ${message}`);
      throw e;
    },

    // Storage that survives restarts, scoped to the module.
    store: {
      get: (k, dflt) => {
        const s = (state.moduleStore || (state.moduleStore = {}))[mod.id] || {};
        return k in s ? s[k] : dflt;
      },
      set: (k, v) => {
        const all = state.moduleStore || (state.moduleStore = {});
        const s = all[mod.id] || (all[mod.id] = {});
        s[k] = v; save();
      },
    },

    // Browser primitives. The trailing argument is the `actions` verb each one needs.
    // This surface must match AUTHORING_GUIDE in mcp.mjs exactly — that guide is what an
    // agent writes its first module against, so a mismatch here is a broken module.
    tabs: {
      // list() enumerates and FILTERS rather than refusing, so a module can see that a
      // tab exists without being able to touch it.
      list: async () => ((await _ctx.relayCommand('tabs.list')) || []).filter((t) => urlAllowed(t.url || '', 'read').allow),
      open: (url, opts = {}) => relay('tab.new', { url, active: !!opts.active }, 'control'),
      navigate: (tabId, url) => relay('tab.navigate', { tabId, url }, 'control'),
      close: (tabId) => relay('tab.close', { tabId }, 'control'),
      activate: (tabId) => relay('tab.activate', { tabId }, 'control'),
      focused: async () => {
        const r = await _ctx.relayCommand('tab.focused');
        const t = r && r.tab;
        return t && urlAllowed(t.url || '', 'read').allow ? t : null;
      },
    },
    read: (tabId, opts = {}) => relay('page.read', { tabId, ...opts }, 'read'),
    eval: (tabId, expression) => relay('page.eval', { tabId, expression }, 'control'),
    click: (tabId, target) => relay('page.click', { tabId, ...(typeof target === 'string' ? { selector: target } : target || {}) }, 'control'),
    fill: (tabId, selector, value, opts = {}) => relay('page.fill', { tabId, selector, value, ...opts }, 'control'),
    scroll: (tabId, opts = {}) => relay('page.scroll', { tabId, ...opts }, 'control'),
    screenshot: (tabId) => relay('page.screenshot', { tabId }, 'read'),
    download: (url, opts = {}) => relay('page.download', { url, ...opts }, 'control'),
    upload: (tabId, selector, files) => relay('page.upload', { tabId, selector, files }, 'control'),
    annotate: (tabId, rules) => relay('overlay.set', { tabId, rules }, 'annotate'),
    annotateClear: (tabId, keys) => relay('overlay.clear', { tabId, ...(keys ? { keys } : {}) }, 'annotate'),
    record: {
      start: (tabId, opts = {}) => relay('monitor.start', { tabId, ...opts }, 'record'),
      stop: (tabId) => relay('monitor.stop', { tabId }, 'record'),
      list: () => _ctx.relayCommand('monitor.list'),
    },

    notify: (message) => notify(mod.name || mod.id, message),

    // Pause until the user has signed in. This is the whole point of authRequired: the
    // module opens the tabs, tells the user what it needs, and waits — rather than
    // scraping a login wall and reporting success.
    needsAuth: (tabIds, message, opts = {}) => waitForAuth(mod, tabIds, message, opts),
  };
}

// A run tells the user what it needs through the extension. Best-effort: a module that
// can't raise a notification should still complete its work.
async function notify(title, message) {
  try { await _ctx.relayCommand('notify', { title: String(title || 'Browser Bridge'), message: String(message || '') }); }
  catch { /* extension offline or notifications denied */ }
  return { ok: true };
}

// Waits for the user to deal with the named tabs. "Done" is judged by the module's own
// `until` predicate when it gives one (e.g. "the dashboard URL, not the login page");
// otherwise by browser activity, which at least means the person saw the prompt.
async function waitForAuth(mod, tabIds, message, { timeoutMs = 10 * 60 * 1000, until } = {}) {
  const ids = [].concat(tabIds || []).map(Number).filter((n) => !Number.isNaN(n));
  await notify(`${mod.name || mod.id} needs you`, message || `Sign in to ${ids.length} tab${ids.length === 1 ? '' : 's'} to continue.`);
  const r = runs(mod.id);
  r.waitingFor = { message: String(message || ''), tabIds: ids, since: Date.now() }; save();

  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      if (typeof until === 'function') {
        try { if (await until()) return { ok: true }; } catch { /* keep waiting */ }
      } else if (browserActive() && Date.now() - started > 5000) {
        return { ok: true };
      }
    }
    throw new Error(`timed out waiting for sign-in: ${message || ids.join(', ')}`);
  } finally {
    r.waitingFor = null; save();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startAutomation() {
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  tick().catch(() => {});
}

export function stopAutomation() { if (_timer) { clearInterval(_timer); _timer = null; } }
