// build-release.mjs — build self-contained Browser Bridge release zips.
//
//   node scripts/build-release.mjs
//
// Produces (in dist/):
//   browser-bridge-macos-v<version>.zip
//   browser-bridge-windows-v<version>.zip
//
// Each zip is SELF-CONTAINED: the bridge source + the browser extension + the one
// required runtime dependency (`ws`, pure JavaScript, cross-platform) + the per-OS
// installer. A user downloads the zip for their OS, extracts it (recommended:
// ~/Applications/Browser Bridge), and runs the installer — no git clone, no
// `npm install`. Node.js is the only prerequisite (installers check for it).
//
// The macOS menu-bar tray (systray2) is intentionally NOT bundled: it ships a
// platform-specific helper binary, and the tray is optional (the bridge runs fine
// without it). macOS users who want the tray can run `npm install` in bridge/.
//
// See RELEASING.md for the full versioning + publishing flow.

import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(ROOT, 'bridge', 'package.json'), 'utf8')).version;
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'browser-bridge');

console.log('Building Browser Bridge v' + version + '…');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// Ship ONLY git-tracked files. This is the safety boundary: anything gitignored
// (secrets/state, logs, recordings, node_modules, and app-specific modules like
// ai-analyst.mjs whose source of truth is another repo) is excluded by construction.
const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);
const EXCLUDE = new Set(['Clean Browser Bridge.command']); // dev wipe tool — never ship it
for (const rel of tracked) {
  if (EXCLUDE.has(rel)) continue;
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue;
  const dst = join(STAGE, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

// Bundle the WHOLE bridge/node_modules — the deps (ws, systray2 + its fs-extra
// chain) are pure JS, and systray2 carries per-platform tray binaries, so the same
// bundle runs on any OS. Cherry-picking top-level deps misses transitive ones
// (systray2 → fs-extra), which silently disables the tray.
const nm = join(ROOT, 'bridge', 'node_modules');
if (!existsSync(join(nm, 'ws')) || !existsSync(join(nm, 'systray2'))) { console.error('deps missing — run `npm install` in bridge/ first.'); process.exit(1); }
cpSync(nm, join(STAGE, 'bridge', 'node_modules'), { recursive: true, filter: (s) => !s.includes('/.cache') && !s.endsWith('/.bin') });

// Zip per OS (identical payload; per-OS names make the right download obvious).
mkdirSync(DIST, { recursive: true });
for (const os of ['macos', 'windows']) {
  const zip = join(DIST, `browser-bridge-${os}-v${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zip, 'browser-bridge'], { cwd: DIST });
  console.log('  wrote ' + zip);
}
rmSync(STAGE, { recursive: true, force: true });

// Double-click installers (users download ONE of these, not the app zip).
//  - macOS: a .command inside a zip. A raw downloaded .command loses its execute
//    bit and won't run; a zip preserves +x. (Gatekeeper still needs right-click →
//    Open once — that's unavoidable until the installer is signed + notarized.)
//  - Windows: a raw .cmd is double-clickable as-is.
const instMac = join(DIST, 'installer-macos');
rmSync(instMac, { recursive: true, force: true });
mkdirSync(instMac, { recursive: true });
copyFileSync(join(ROOT, 'bootstrap.sh'), join(instMac, 'Install Browser Bridge.command'));
execFileSync('chmod', ['+x', join(instMac, 'Install Browser Bridge.command')]);
copyFileSync(join(ROOT, 'READ ME FIRST (macOS).txt'), join(instMac, 'READ ME FIRST (macOS).txt'));
const macInstallerZip = join(DIST, `Install-Browser-Bridge-macOS-v${version}.zip`);
rmSync(macInstallerZip, { force: true });
execFileSync('zip', ['-q', '-j', '-X', macInstallerZip,
  join(instMac, 'Install Browser Bridge.command'),
  join(instMac, 'READ ME FIRST (macOS).txt')]);
rmSync(instMac, { recursive: true, force: true });
console.log('  wrote ' + macInstallerZip);

writeFileSync(join(DIST, `Install-Browser-Bridge-Windows-v${version}.cmd`),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/jaymart1983/browser-bridge/main/bootstrap.ps1 | iex"\r\npause\r\n');
console.log('  wrote ' + join(DIST, `Install-Browser-Bridge-Windows-v${version}.cmd`));

console.log('Done. Attach all dist/* artifacts to the GitHub Release for v' + version + '.');
