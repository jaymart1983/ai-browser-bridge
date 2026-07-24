// updater.mjs — opt-in self-update, tracking the latest RELEASE TAG.
//
// The bridge is a git clone run under launchd. It follows the newest published
// release tag (e.g. v0.2.0), NOT the bleeding edge of `main` — so you can develop
// freely on main and users only move when you deliberately cut a release. Applying
// fast-forwards the clone to that tag and restarts. Loopback control only.
//
// GUARDRAILS (never clobber local/unpushed work — the AI Analyst app and manual
// edits live in this same repo):
//   * FAST-FORWARD ONLY to the tag — never a merge.
//   * Only when the working tree is CLEAN.
//   * Only when HEAD is an ancestor of the tag (no local-ahead commits).
//   * Auto-apply is OFF by default (surface "update available" for one-click apply).
//
// NOTE: this is the update path for a GIT-CLONE install. A zip/release install
// (no .git) updates by downloading the release asset instead — see RELEASING.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
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
  if (!isGitClone()) return { channel: 'zip', version: bridgeVersion(), autoUpdate: getAutoUpdate(), note: 'Not a git install — updates via downloaded release (see RELEASING.md).' };
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

// Fast-forward the clone to the latest release tag + restart.
export async function applyUpdate() {
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
  if (!isGitClone()) { log('not a git install — periodic self-update disabled'); return; }
  const tick = async () => {
    try {
      const st = await checkForUpdate();
      if (getAutoUpdate() && st.canFastForward) { log('auto-updating to ' + st.tag); await applyUpdate(); }
      else if (st.behind > 0) log('update available: ' + st.tag + (st.canFastForward ? '' : ' (not fast-forwardable)') + (getAutoUpdate() ? '' : '; auto-update off'));
    } catch (e) { log('check failed:', e && e.message); }
  };
  setTimeout(tick, 15000);
  setInterval(tick, intervalMs);
}
