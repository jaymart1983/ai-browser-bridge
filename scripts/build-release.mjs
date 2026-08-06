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

import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(ROOT, 'bridge', 'package.json'), 'utf8')).version;
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'browser-bridge');

// Pre-release checks (versions, secrets, tracked-file hygiene, deps, loopback
// posture). Skippable for a local scratch build, never for a real release.
if (!process.argv.includes('--skip-preflight')) {
  try {
    execFileSync('node', [join(ROOT, 'scripts', 'preflight.mjs')], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('\nBuild ABORTED by preflight. Fix the failures above, or pass --skip-preflight for a scratch build.');
    process.exit(1);
  }
}

console.log('Building Browser Bridge v' + version + '…');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// Ship ONLY git-tracked files. This is the safety boundary: anything gitignored
// (secrets/state, logs, recordings, node_modules, and app-specific modules whose
// source of truth is another repo) is excluded by construction.
const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);
// Tracked-but-not-shipped: things that belong to DEVELOPING the bridge, not to running
// it. A zip install is the finished application; release tooling and repo bookkeeping in
// there is just clutter that invites someone to run the wrong thing. (A git-channel
// install is a checkout by definition and keeps everything — that IS the dev copy.)
const EXCLUDE = new Set([
  'Clean Browser Bridge.command', // dev wipe tool — never ship it
  'RELEASING.md',                 // how to cut a release; meaningless in an install
  '.gitignore',                   // repo bookkeeping
]);
const EXCLUDE_DIRS = ['scripts/', '.github/']; // build/release tooling and CI
const shipped = (rel) => !EXCLUDE.has(rel) && !EXCLUDE_DIRS.some((d) => rel.startsWith(d));
for (const rel of tracked) {
  if (!shipped(rel)) continue;
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue;
  const dst = join(STAGE, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

// GUARD: every relative import in the STAGED code must resolve to a file that
// actually made it into the payload. This catches an untracked / uncommitted source
// file (e.g. a new .mjs the shipped server imports) BEFORE it goes out as a
// crash-looping zip — exactly the "clients.mjs missing from the zip" bug. We abort
// and delete the stage rather than publish a broken build.
function missingImportsUnder(dir) {
  const miss = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|cjs|js)$/.test(e.name)) continue;
      const text = readFileSync(p, 'utf8');
      const re = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+\.(?:mjs|cjs|js|json))['"]/g;
      let m;
      while ((m = re.exec(text))) {
        if (!existsSync(resolve(dirname(p), m[1]))) miss.push(`${relative(STAGE, p)} → ${m[1]}`);
      }
    }
  };
  walk(dir);
  return miss;
}
// The import scan only sees JS `import`s. Files the EXTENSION MANIFEST references —
// content scripts, the service worker, the popup, web-accessible resources — are wired
// by name in JSON, so a new one that isn't git-tracked yet ships as a broken extension
// with no import to catch it. Check those too.
function missingManifestRefs(stageExtDir) {
  const mfPath = join(stageExtDir, 'manifest.json');
  if (!existsSync(mfPath)) return [];
  let mf;
  try { mf = JSON.parse(readFileSync(mfPath, 'utf8')); } catch { return ['extension/manifest.json → unparseable']; }
  const refs = [];
  const add = (v) => { if (typeof v === 'string' && v && !/^https?:/.test(v)) refs.push(v); };
  add(mf.background && mf.background.service_worker);
  add(mf.action && mf.action.default_popup);
  add(mf.options_page);
  for (const cs of mf.content_scripts || []) { for (const f of [...(cs.js || []), ...(cs.css || [])]) add(f); }
  for (const w of mf.web_accessible_resources || []) { for (const f of (w.resources || [])) if (!String(f).includes('*')) add(f); }
  for (const v of Object.values((mf.icons) || {})) add(v);
  for (const v of Object.values((mf.action && mf.action.default_icon) || {})) add(v);
  return refs.filter((r) => !existsSync(join(stageExtDir, r))).map((r) => `extension/manifest.json → ${r}`);
}

const missing = [
  ...missingImportsUnder(join(STAGE, 'bridge')),
  ...missingImportsUnder(join(STAGE, 'extension')),
  ...missingManifestRefs(join(STAGE, 'extension')),
];
if (missing.length) {
  rmSync(STAGE, { recursive: true, force: true });
  console.error('Release ABORTED — shipped code imports files not present in the build (untracked/uncommitted?):');
  for (const x of missing) console.error('  - ' + x);
  console.error('Fix: `git add` the missing file(s), then rebuild.');
  process.exit(1);
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

// No double-click installers. Install is the one-line curl/irm command (see the
// release notes / README) — it must run in a terminal anyway to strip quarantine
// and ad-hoc sign the tray, so a downloaded .command/.cmd added no value.

console.log('Done. Attach the two platform zips to the GitHub Release for v' + version + '.');
