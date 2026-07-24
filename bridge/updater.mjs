// updater.mjs — opt-in self-update from the git remote.
//
// The bridge is a git clone run under launchd. This fast-forwards the clone to
// `origin/<branch>` and restarts so the new code loads. Loopback control only.
//
// GUARDRAILS (so it can never clobber local/unpushed work — the AI Analyst app
// and manual edits both live in this same repo):
//   * FAST-FORWARD ONLY — never a merge; if the branches diverged it refuses.
//   * Only when the working tree is CLEAN (no uncommitted tracked changes).
//   * Only when there are NO local commits missing from origin (ahead === 0).
//   * Auto-apply is OFF by default; the default is check + surface "update
//     available" for a one-click manual apply.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, save } from './state.mjs';

const execFileP = promisify(execFile);
const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url)); // .../browser-bridge/bridge
const REPO_DIR = dirname(BRIDGE_DIR);                        // .../browser-bridge (git root)
const SERVICE = 'com.aibrowserbridge';

let last = { checkedAt: 0 };
let checking = false;
let onExtensionUpdated = null; // called after a pull that changed extension/ source
export function configureUpdater(o) { onExtensionUpdated = (o && o.onExtensionUpdated) || null; }

const log = (...a) => console.log('[updater]', ...a);
async function git(args, timeout = 30000) {
  const { stdout } = await execFileP('git', ['-C', REPO_DIR, ...args], { timeout });
  return stdout.trim();
}
function bridgeVersion() {
  try { return JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

export function getAutoUpdate() { return state.autoUpdate === true; }
export function setAutoUpdate(on) { state.autoUpdate = !!on; save(); return { ok: true, autoUpdate: state.autoUpdate }; }

// Current status vs the last fetch (no network here).
export async function getStatus() {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const sha = await git(['rev-parse', '--short', 'HEAD']);
    const remoteUrl = await git(['remote', 'get-url', 'origin']).catch(() => '');
    const upstream = 'origin/' + branch;
    let behind = 0, ahead = 0, remoteSha = '';
    try { remoteSha = await git(['rev-parse', '--short', upstream]); } catch {}
    try {
      const c = await git(['rev-list', '--left-right', '--count', 'HEAD...' + upstream]);
      const [a, b] = c.split(/\s+/).map(Number); ahead = a || 0; behind = b || 0;
    } catch {}
    const clean = (await git(['status', '--porcelain'])) === '';
    return {
      ...last, version: bridgeVersion(), branch, sha, remoteSha, remoteUrl,
      behind, ahead, clean, canFastForward: clean && behind > 0 && ahead === 0,
      autoUpdate: getAutoUpdate(),
    };
  } catch (e) {
    return { error: String((e && e.message) || e), version: bridgeVersion(), autoUpdate: getAutoUpdate() };
  }
}

// Fetch from origin, then return fresh status.
export async function checkForUpdate() {
  if (checking) return getStatus();
  checking = true;
  try { await git(['fetch', '--quiet', 'origin']); last = { checkedAt: Date.now() }; }
  catch (e) { last = { checkedAt: Date.now(), fetchError: String((e && e.message) || e) }; }
  finally { checking = false; }
  return getStatus();
}

// Fast-forward + restart. Returns {ok} or {ok:false,error}.
export async function applyUpdate() {
  const st = await getStatus();
  if (st.error) return { ok: false, error: st.error };
  if (!st.clean) return { ok: false, error: 'Local changes present — refusing to auto-update (commit or discard them first).' };
  if (st.ahead > 0) return { ok: false, error: 'Local commits are not on origin — cannot fast-forward.' };
  if (st.behind === 0) return { ok: false, error: 'Already up to date.' };
  const before = st.sha;
  try { await git(['pull', '--ff-only', 'origin', st.branch], 60000); }
  catch (e) { return { ok: false, error: 'git pull failed: ' + String((e && e.message) || e) }; }
  let changed = '';
  try { changed = '\n' + await git(['diff', '--name-only', before, 'HEAD']) + '\n'; } catch {}
  if (/\nbridge\/package(-lock)?\.json\n/.test(changed)) { try { await execFileP('npm', ['install', '--no-audit', '--no-fund'], { cwd: BRIDGE_DIR, timeout: 180000 }); } catch (e) { log('npm install failed:', e && e.message); } }
  // If the extension source changed, ask connected extensions to reload from disk
  // (chrome.runtime.reload re-reads the unpacked files the pull just updated).
  const extensionChanged = /\nextension\//.test(changed);
  if (extensionChanged && onExtensionUpdated) { try { onExtensionUpdated(); } catch {} }
  const to = await git(['rev-parse', '--short', 'HEAD']).catch(() => '');
  log('updated ' + before + ' -> ' + to + (extensionChanged ? ' (extension reload signaled)' : '') + '; restarting');
  scheduleRestart();
  return { ok: true, restarting: true, from: before, to, extensionChanged };
}

// Restart so the new code loads. launchd (KeepAlive) brings us back.
function scheduleRestart() {
  setTimeout(() => {
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid != null) { execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE}`], () => setTimeout(() => process.exit(0), 500)); return; }
    } catch {}
    process.exit(0);
  }, 800);
}

// Periodic checker: first check shortly after boot, then every intervalMs. Applies
// automatically only when auto-update is on AND a clean fast-forward is possible.
export function startUpdateChecker(intervalMs = 6 * 60 * 60 * 1000) {
  const tick = async () => {
    try {
      const st = await checkForUpdate();
      if (getAutoUpdate() && st.canFastForward) { log('auto-updating ' + st.sha + ' -> ' + st.remoteSha); await applyUpdate(); }
      else if (st.behind > 0) log('update available: ' + st.behind + ' behind (' + st.sha + ' -> ' + st.remoteSha + ')' + (getAutoUpdate() ? ' but not fast-forwardable' : '; auto-update off'));
    } catch (e) { log('check failed:', e && e.message); }
  };
  setTimeout(tick, 15000);
  setInterval(tick, intervalMs);
}
