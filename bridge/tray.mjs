// tray.mjs — optional macOS/Linux/Windows menubar (tray) icon for the bridge.
//   Blue  = bridge running, nothing recording.
//   Green = at least one tab is recording.
// Loaded defensively: if systray2 (or its helper binary) is unavailable, the
// bridge runs exactly as before — the tray is a nicety, never a dependency.

import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

// --- Minimal PNG encoder (filled circle) so we ship no binary icon files. ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngCircle(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2, cy = (size - 1) / 2, rad = size * 0.42;
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // scanline filter: none
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - cx, y - cy) <= rad;
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const ICONS = { idle: pngCircle(22, [59, 130, 246]), recording: pngCircle(22, [46, 158, 68]) };

let systray = null;
let state = 'idle';

const SEP = { title: '<SEPARATOR>', tooltip: '', enabled: true };
const item = (title, tooltip, act, extra) => ({ title, tooltip, checked: false, enabled: true, ...(extra || {}), __act: act });

// Everything the menu needs from the bridge, refreshed each time it is rebuilt.
let cfg = { origin: '', dashboardUrl: '', version: '', modules: () => [], onQuit: null, onRestart: null, onCheckUpdates: null };

function menuFor(s) {
  const mods = (() => { try { return cfg.modules() || []; } catch { return []; } })();
  // A module's own page, plus the manage-all page. Mirrors the submenu shape of a
  // host app's tray so the two feel like the same product.
  const moduleItems = [
    ...mods.map((m) => item(m.name || m.id, 'Open ' + (m.name || m.id), { open: cfg.origin + '/modules/' + m.id })),
    ...(mods.length ? [SEP] : []),
    item(mods.length ? 'Manage modules…' : 'No modules enabled — manage…', 'Enable or disable capability modules', { open: cfg.origin + '/modules' }),
  ];
  return {
    icon: ICONS[s], isTemplateIcon: false, title: '',
    tooltip: 'Browser Bridge' + (s === 'recording' ? ' — recording' : ''),
    items: [
      // Title row: identifies the app and its version, like a macOS app menu header.
      { title: 'Browser Bridge' + (cfg.version ? ' ' + cfg.version : ''), tooltip: 'Loopback only — nothing leaves this device', checked: false, enabled: false },
      SEP,
      item('Open Dashboard', 'Live activity', { open: cfg.dashboardUrl }),
      { title: 'Modules', tooltip: 'Open a module, or manage them', checked: false, enabled: true, items: moduleItems },
      SEP,
      item('Check for Updates…', 'Ask GitHub for a newer release', { check: true }),
      SEP,
      item('Restart Browser Bridge', 'Stop and start the bridge', { restart: true }),
      item('Quit Browser Bridge', 'Stop the bridge until you start it again', { quit: true }),
    ],
  };
}

// systray2 numbers items depth-first, parent BEFORE its children, starting at 1 — and
// it does NOT re-register those ids when the menu is replaced via update-menu, so its
// own lookup table goes stale the moment the module list changes. Mirror the numbering
// here and keep our OWN id → action map, rebuilt with every menu.
function mapActions(items, ctr, out) {
  for (const it of items) {
    const id = ctr.n++;
    if (it.__act) out.set(id, it.__act);
    if (it.items) mapActions(it.items, ctr, out);
  }
  return out;
}

// The systray helper is a spawned child binary; its failures surface as ASYNC
// uncaught exceptions that a local try/catch can't reach. Guard the process so a
// tray problem can never take the bridge down — while leaving all other
// uncaught exceptions fatal as before.
let guardInstalled = false;
function installTrayGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  process.on('uncaughtException', (e) => {
    const s = String((e && e.message) || e) + '|' + String((e && e.syscall) || '') + '|' + String((e && e.path) || '');
    if (/tray_|node-systray|systray/i.test(s)) return; // swallow tray-only flakiness
    throw e; // not the tray → restore fatal behavior
  });
}

// Make the tray helper binary executable. When a host app bundles the bridge, the
// helper is embedded via go:embed and re-extracted with os.WriteFile → mode 0644
// (embed.FS carries no exec bit), so systray2 would copy a NON-executable binary
// and the spawn would fail. Fix the bit on BOTH the vendored traybin (what the
// bundle ships, resolved next to the systray2 package) and the legacy ~/.cache
// path (older node-systray layout). Best effort — never fatal.
async function ensureBinExecutable() {
  const bin = process.platform === 'darwin' ? 'tray_darwin_release'
    : process.platform === 'win32' ? 'tray_windows_release.exe' : 'tray_linux_release';
  try {
    const { chmodSync, existsSync } = await import('node:fs');
    const os = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { createRequire } = await import('node:module');
    const cands = [];
    // 1) vendored traybin, resolved next to the systray2 package (the bundle path).
    try {
      const require = createRequire(import.meta.url);
      const sysPkg = require.resolve('systray2/package.json');
      cands.push(join(dirname(sysPkg), 'traybin', bin));
    } catch { /* not resolvable → fall through */ }
    // 2) relative to the bridge dir (cwd = layout.Bridge when spawned by a host app).
    cands.push(join(process.cwd(), 'node_modules', 'systray2', 'traybin', bin));
    // 3) relative to this module (dev / alternate cwd).
    try { cands.push(join(dirname(fileURLToPath(import.meta.url)), 'node_modules', 'systray2', 'traybin', bin)); } catch {}
    // 4) legacy node-systray cache layout.
    cands.push(join(os.homedir(), '.cache', 'node-systray', '2.1.4', bin));
    for (const p of cands) {
      try { if (existsSync(p)) chmodSync(p, 0o755); } catch { /* keep trying */ }
    }
  } catch { /* best effort */ }
}

// Open a URL in the user's default browser, on any platform. (`open` is macOS-only;
// the tray also runs on Windows and Linux.)
function openUrl(u) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best effort */ }
}

let actions = new Map();

export async function startTray({ origin, dashboardUrl, version, modules, onQuit, onRestart, onCheckUpdates }) {
  try {
    installTrayGuard();
    await ensureBinExecutable();
    const mod = await import('systray2');
    const SysTray = (mod.default && mod.default.default) || mod.default;
    // `origin` is the bare http://host:port. It must NOT be derived from dashboardUrl,
    // which now carries a module's path — concatenating onto that produced URLs like
    // /modules/research?tab=activity/modules.
    cfg = {
      origin: String(origin || '').replace(/\/$/, ''),
      dashboardUrl: dashboardUrl || origin,
      version: version || '',
      modules: modules || (() => []),
      onQuit, onRestart, onCheckUpdates,
    };
    const menu = menuFor('idle');
    actions = mapActions(menu.items, { n: 1 }, new Map());
    systray = new SysTray({ menu, debug: false, copyDir: true });
    systray.onClick((action) => {
      const act = actions.get(action.__id);
      if (!act) return;
      if (act.open) { openUrl(act.open); return; }
      if (act.check) {
        // Refresh the update status, then show it where it can be acted on.
        Promise.resolve(cfg.onCheckUpdates && cfg.onCheckUpdates())
          .catch(() => {})
          .finally(() => openUrl(cfg.origin + '/config'));
        return;
      }
      if (act.restart) { if (cfg.onRestart) cfg.onRestart(); return; }
      if (act.quit) { try { systray.kill(false); } catch {} if (cfg.onQuit) cfg.onQuit(); }
    });
    await systray.ready();
    return true;
  } catch {
    systray = null;
    return false;
  }
}

// Rebuild the menu (e.g. after modules change) so the submenu stays truthful.
export function refreshTrayMenu() {
  if (!systray) return;
  const menu = menuFor(state);
  actions = mapActions(menu.items, { n: 1 }, new Map());
  try { systray.sendAction({ type: 'update-menu', menu, seq_id: -1 }); } catch { /* tray is optional */ }
}

export function setTrayState(next) {
  const s = next === 'recording' ? 'recording' : 'idle';
  if (!systray || s === state) return;
  state = s;
  // Rebuild through the shared path so the id → action map is regenerated with it.
  refreshTrayMenu();
}

export function stopTray() {
  try { if (systray) systray.kill(false); } catch {}
  systray = null;
}
