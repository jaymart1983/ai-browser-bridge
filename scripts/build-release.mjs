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

import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
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
for (const rel of tracked) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue;
  const dst = join(STAGE, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

// Bundle the single required runtime dep (pure JS → safe on any OS).
const wsSrc = join(ROOT, 'bridge', 'node_modules', 'ws');
if (!existsSync(wsSrc)) { console.error('ws not installed — run `npm install` in bridge/ first.'); process.exit(1); }
mkdirSync(join(STAGE, 'bridge', 'node_modules'), { recursive: true });
cpSync(wsSrc, join(STAGE, 'bridge', 'node_modules', 'ws'), { recursive: true });

// Zip per OS (identical payload; per-OS names make the right download obvious).
mkdirSync(DIST, { recursive: true });
for (const os of ['macos', 'windows']) {
  const zip = join(DIST, `browser-bridge-${os}-v${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zip, 'browser-bridge'], { cwd: DIST });
  console.log('  wrote ' + zip);
}
rmSync(STAGE, { recursive: true, force: true });
console.log('Done. Attach the two dist/*.zip files to the GitHub Release for v' + version + '.');
