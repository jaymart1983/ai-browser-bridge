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

function menuFor(s) {
  return {
    icon: ICONS[s], isTemplateIcon: false, title: '',
    tooltip: 'AI Browser Bridge' + (s === 'recording' ? ' — recording' : ''),
    items: [
      { title: 'Open Dashboard', tooltip: 'Recordings / activity', checked: false, enabled: true },
      { title: 'Modules', tooltip: 'Enable/disable capability modules', checked: false, enabled: true },
      { title: 'Rule Builder', tooltip: 'Source → Destination : Permission', checked: false, enabled: true },
      { title: 'Quit Bridge', tooltip: 'Stop the bridge', checked: false, enabled: true },
    ],
  };
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

// Make the extracted helper binary executable (systray2 sometimes leaves it 0644).
async function ensureBinExecutable() {
  try {
    const { chmodSync, existsSync } = await import('node:fs');
    const os = await import('node:os');
    const { join } = await import('node:path');
    const p = join(os.homedir(), '.cache', 'node-systray', '2.1.4',
      process.platform === 'darwin' ? 'tray_darwin_release'
      : process.platform === 'win32' ? 'tray_windows_release.exe' : 'tray_linux_release');
    if (existsSync(p)) chmodSync(p, 0o755);
  } catch { /* best effort */ }
}

export async function startTray({ dashboardUrl, onQuit }) {
  try {
    installTrayGuard();
    await ensureBinExecutable();
    const mod = await import('systray2');
    const SysTray = (mod.default && mod.default.default) || mod.default;
    systray = new SysTray({ menu: menuFor('idle'), debug: false, copyDir: true });
    const base = String(dashboardUrl).replace(/\/$/, '');
    const openUrl = (u) => { try { spawn('open', [u]); } catch {} };
    systray.onClick((action) => {
      if (action.seq_id === 0) openUrl(dashboardUrl);
      else if (action.seq_id === 1) openUrl(base + '/modules');
      else if (action.seq_id === 2) openUrl(base + '/rules');
      else if (action.seq_id === 3) { try { systray.kill(false); } catch {} if (onQuit) onQuit(); }
    });
    await systray.ready();
    return true;
  } catch {
    systray = null;
    return false;
  }
}

export function setTrayState(next) {
  const s = next === 'recording' ? 'recording' : 'idle';
  if (!systray || s === state) return;
  state = s;
  try { systray.sendAction({ type: 'update-menu', menu: menuFor(s), seq_id: -1 }); } catch {}
}

export function stopTray() {
  try { if (systray) systray.kill(false); } catch {}
  systray = null;
}
