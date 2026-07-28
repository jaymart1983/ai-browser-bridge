// updater.mjs — opt-in self-update, tracking the latest RELEASE TAG.
//
// The bridge is a git clone run under launchd. It follows the newest published
// release tag (e.g. v0.2.0), NOT the bleeding edge of `main` — so you can develop
// freely on main and users only move when you deliberately cut a release. Applying
// fast-forwards the clone to that tag and restarts. Loopback control only.
//
// GUARDRAILS (never clobber local/unpushed work — a host app and manual
// edits may live in this same repo):
//   * FAST-FORWARD ONLY to the tag — never a merge.
//   * Only when the working tree is CLEAN.
//   * Only when HEAD is an ancestor of the tag (no local-ahead commits).
//   * Auto-apply is OFF by default (surface "update available" for one-click apply).
//
// NOTE: this is the update path for a GIT-CLONE install. A zip/release install
// (no .git) updates by downloading the release asset instead — see RELEASING.md.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, save } from './state.mjs';

const execFileP = promisify(execFile);
const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url)); // .../browser-bridge/bridge
const REPO_DIR = dirname(BRIDGE_DIR);                        // install dir (git root for git installs)
const SERVICE = 'com.browserbridge';
const IS_WIN = process.platform === 'win32';

function readRuntime() { try { return JSON.parse(readFileSync(join(REPO_DIR, 'runtime.json'), 'utf8')); } catch { return {}; } }
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}

let last = { checkedAt: 0 };
let checking = false;
let onExtensionUpdated = null; // called after a pull that changed extension/ source
export function configureUpdater(o) { onExtensionUpdated = (o && o.onExtensionUpdated) || null; }

const log = (...a) => console.log('[updater]', ...a);
const isGitClone = () => existsSync(join(REPO_DIR, '.git'));
async function git(args, timeout = 30000) {
  const { stdout } = await execFileP('git', ['-C', REPO_DIR, ...args], { timeout });
  return stdout.trim();
}
function bridgeVersion() {
  try { return JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}
// Highest semver release tag known locally (fetch first to refresh).
async function latestReleaseTag() {
  try {
    const out = await git(['tag', '-l', '--sort=-version:refname']);
    return out.split('\n').map((t) => t.trim()).find((t) => /^v?\d+\.\d+\.\d+/.test(t)) || null;
  } catch { return null; }
}

export function getAutoUpdate() { return state.autoUpdate === true; }
export function setAutoUpdate(on) { state.autoUpdate = !!on; save(); return { ok: true, autoUpdate: state.autoUpdate }; }

// Current status vs the latest release tag (no network here).
export async function getStatus() {
  if (!isGitClone()) return getZipStatus();
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const sha = await git(['rev-parse', '--short', 'HEAD']);
    const remoteUrl = await git(['remote', 'get-url', 'origin']).catch(() => '');
    const clean = (await git(['status', '--porcelain'])) === '';
    const tag = await latestReleaseTag();
    let tagSha = '', behind = 0, ahead = 0, atLatest = false, canFastForward = false;
    if (tag) {
      tagSha = await git(['rev-parse', '--short', tag + '^{commit}']).catch(() => '');
      behind = Number(await git(['rev-list', '--count', 'HEAD..' + tag]).catch(() => '0')) || 0;
      ahead = Number(await git(['rev-list', '--count', tag + '..HEAD']).catch(() => '0')) || 0;
      atLatest = behind === 0 && ahead === 0;
      canFastForward = clean && behind > 0 && ahead === 0;
    }
    return { ...last, channel: 'release', version: bridgeVersion(), branch, sha, tag, tagSha, remoteUrl, atLatest, behind, ahead, clean, canFastForward, autoUpdate: getAutoUpdate() };
  } catch (e) {
    return { error: String((e && e.message) || e), version: bridgeVersion(), autoUpdate: getAutoUpdate() };
  }
}

// Fetch branches + tags from origin, then return fresh status.
export async function checkForUpdate() {
  if (!isGitClone()) return getStatus();
  if (checking) return getStatus();
  checking = true;
  try { await git(['fetch', '--quiet', '--tags', '--prune-tags', 'origin']); last = { checkedAt: Date.now() }; }
  catch (e) { last = { checkedAt: Date.now(), fetchError: String((e && e.message) || e) }; }
  finally { checking = false; }
  return getStatus();
}

// ---- ZIP channel: download the release asset, swap files, update runtime -------
// GitHub's public Releases API tells us the latest tag + asset URLs.
async function githubLatestRelease(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'browser-bridge-updater' } });
  if (r.status === 404) return null; // no releases published yet
  if (!r.ok) throw new Error('GitHub API ' + r.status);
  return r.json();
}
export async function getZipStatus() {
  const rt = readRuntime();
  const version = bridgeVersion();
  const platform = IS_WIN ? 'windows' : 'macos';
  let latestVersion = null, assetUrl = null, error = null;
  try {
    const rel = rt.repo ? await githubLatestRelease(rt.repo) : null;
    if (rel) {
      latestVersion = String(rel.tag_name || '').replace(/^v/, '');
      const a = (rel.assets || []).find((x) => x.name.includes(platform) && x.name.endsWith('.zip'));
      assetUrl = a ? a.browser_download_url : null;
    }
  } catch (e) { error = String((e && e.message) || e); }
  const behind = latestVersion && cmpSemver(latestVersion, version) > 0;
  return { channel: 'zip', version, platform, repo: rt.repo || '', nodePinned: rt.node || '', nodeRunning: process.versions.node, latest: latestVersion, updateAvailable: !!(behind && assetUrl), assetUrl, autoUpdate: getAutoUpdate(), checkedAt: Date.now(), error };
}

// Download + swap in place. State/recordings/runtime aren't in the zip, so copying
// the payload over the install dir preserves them. Restarts to load new code.
async function applyZipUpdate() {
  const st = await getZipStatus();
  if (st.error) return { ok: false, error: st.error };
  if (!st.updateAvailable) return { ok: false, error: 'Already on the latest release.' };
  const tmp = mkdtempSync(join(tmpdir(), 'bb-upd-'));
  try {
    const zip = join(tmp, 'release.zip');
    const res = await fetch(st.assetUrl);
    if (!res.ok) return { ok: false, error: 'download failed ' + res.status };
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    const stage = join(tmp, 'stage');
    await execFileP(IS_WIN ? 'powershell' : 'unzip', IS_WIN ? ['-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${stage}' -Force`] : ['-q', zip, '-d', stage]);
    const src = join(stage, 'browser-bridge'); // top-level folder inside the zip
    const newRt = (() => { try { return JSON.parse(readFileSync(join(src, 'runtime.json'), 'utf8')); } catch { return {}; } })();
    const nodeChanged = !!(newRt.node && newRt.node !== process.versions.node);
    // Swap the app payload over the install dir (never touches runtime/ or state — not in the zip).
    cpSync(src, REPO_DIR, { recursive: true, force: true });
    if (nodeChanged) { try { await updateNodeRuntime(newRt.node); } catch (e) { log('runtime update failed:', e && e.message); } }
    if (onExtensionUpdated) { try { onExtensionUpdated(); } catch {} }
    log('zip-updated to v' + st.latest + (nodeChanged ? ' + Node ' + newRt.node : '') + '; restarting');
    scheduleRestart();
    return { ok: true, restarting: true, to: st.latest, nodeChanged };
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

// Update the bundled Node runtime to `ver`. macOS: replace runtime/node (the running
// process keeps the old inode; next launch uses the new file). Windows: the running
// node.exe is locked, so stage node.new — the run-bridge.cmd launcher swaps it on the
// next start before relaunching node.
async function updateNodeRuntime(ver) {
  const runtime = join(REPO_DIR, 'runtime');
  mkdirSync(runtime, { recursive: true });
  if (IS_WIN) {
    const pkg = `node-v${ver}-win-x64`;
    await execFileP('powershell', ['-Command',
      `$u='https://nodejs.org/dist/v${ver}/${pkg}.zip'; $t=Join-Path $env:TEMP 'bbn.zip'; Invoke-WebRequest $u -OutFile $t; ` +
      `$e=Join-Path $env:TEMP 'bbn'; Remove-Item -Recurse -Force $e -EA SilentlyContinue; Expand-Archive $t $e -Force; ` +
      `Copy-Item (Join-Path $e '${pkg}\\node.exe') '${join(runtime, 'node.new')}' -Force`]);
  } else {
    const na = process.arch === 'arm64' ? 'arm64' : 'x64';
    const pkg = `node-v${ver}-darwin-${na}`;
    await execFileP('bash', ['-c', `curl -fsSL "https://nodejs.org/dist/v${ver}/${pkg}.tar.gz" | tar xz -C "${runtime}" --strip-components=2 "${pkg}/bin/node"`], { timeout: 180000 });
  }
}

// Fast-forward the clone to the latest release tag + restart.
export async function applyUpdate() {
  if (!isGitClone()) return applyZipUpdate();
  const st = await getStatus();
  if (st.error) return { ok: false, error: st.error };
  if (st.channel !== 'release') return { ok: false, error: 'Not a git install — download the latest release instead.' };
  if (!st.tag) return { ok: false, error: 'No releases published yet.' };
  if (!st.clean) return { ok: false, error: 'Local changes present — refusing to auto-update (commit or discard them first).' };
  if (st.ahead > 0) return { ok: false, error: 'Local commits are ahead of the latest release — cannot fast-forward.' };
  if (st.behind === 0) return { ok: false, error: 'Already on the latest release.' };
  const before = st.sha;
  try { await git(['merge', '--ff-only', st.tag], 60000); }
  catch (e) { return { ok: false, error: 'fast-forward failed: ' + String((e && e.message) || e) }; }
  let changed = '';
  try { changed = '\n' + await git(['diff', '--name-only', before, 'HEAD']) + '\n'; } catch {}
  if (/\nbridge\/package(-lock)?\.json\n/.test(changed)) { try { await execFileP('npm', ['install', '--no-audit', '--no-fund'], { cwd: BRIDGE_DIR, timeout: 180000 }); } catch (e) { log('npm install failed:', e && e.message); } }
  const extensionChanged = /\nextension\//.test(changed);
  if (extensionChanged && onExtensionUpdated) { try { onExtensionUpdated(); } catch {} }
  const to = await git(['rev-parse', '--short', 'HEAD']).catch(() => '');
  log('updated to ' + st.tag + ' (' + before + ' -> ' + to + ')' + (extensionChanged ? ' (extension reload signaled)' : '') + '; restarting');
  scheduleRestart();
  return { ok: true, restarting: true, tag: st.tag, from: before, to, extensionChanged };
}

// Restart so the new code loads. The service manager (launchd / Task Scheduler)
// brings us back — and on Windows the run-bridge.cmd launcher swaps node.new first.
function scheduleRestart() {
  setTimeout(() => {
    try {
      if (IS_WIN) {
        // Detached so it survives this process ending, then re-runs the task
        // (run-bridge.cmd swaps node.new into place before relaunching node).
        spawn('cmd', ['/c', 'timeout /t 1 >nul & schtasks /run /tn BrowserBridge'], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => process.exit(0), 300); return;
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid != null) { execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE}`], () => setTimeout(() => process.exit(0), 500)); return; }
    } catch {}
    process.exit(0);
  }, 800);
}

// Periodic checker: first check shortly after boot, then every intervalMs. Applies
// automatically only when auto-update is on AND an update is cleanly available.
export function startUpdateChecker(intervalMs = 6 * 60 * 60 * 1000) {
  const tick = async () => {
    try {
      const st = await checkForUpdate();
      const canApply = st.channel === 'zip' ? st.updateAvailable : st.canFastForward;
      const label = st.tag || (st.latest ? 'v' + st.latest : '');
      if (getAutoUpdate() && canApply) { log('auto-updating' + (label ? ' to ' + label : '')); await applyUpdate(); }
      else if (st.behind > 0 || st.updateAvailable) log('update available' + (label ? ': ' + label : '') + (getAutoUpdate() ? '' : '; auto-update off'));
    } catch (e) { log('check failed:', e && e.message); }
  };
  setTimeout(tick, 15000);
  setInterval(tick, intervalMs);
}
