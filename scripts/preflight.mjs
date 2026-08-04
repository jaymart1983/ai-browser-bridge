// preflight.mjs — pre-release checks. Run BEFORE cutting a release:
//
//   node scripts/preflight.mjs           # report
//   node scripts/preflight.mjs --strict  # non-zero exit on any WARN too
//
// Exit code is non-zero when a FAIL is found, so it can gate a release.
//
// Why this exists: releases here have shipped broken twice (a source file missing
// from the zip; a file referenced only from manifest.json). Both were invisible until
// a user hit them. Everything below is a check that would have caught a real defect,
// not box-ticking — if a check stops earning its place, delete it.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STRICT = process.argv.includes('--strict');
const results = [];
const fail = (area, msg, detail) => results.push({ level: 'FAIL', area, msg, detail });
const warn = (area, msg, detail) => results.push({ level: 'WARN', area, msg, detail });
const info = (area, msg, detail) => results.push({ level: 'ok', area, msg, detail });

const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
  catch (e) { return (e && (e.stdout || '')) || ''; }
};
const tracked = sh('git', ['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
const readIf = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------------------
// 1. Version consistency — the bridge and the extension are shipped as one unit.
// ---------------------------------------------------------------------------
{
  let bv = '', ev = '';
  try { bv = JSON.parse(readIf('bridge/package.json')).version || ''; } catch {}
  try { ev = JSON.parse(readIf('extension/manifest.json')).version || ''; } catch {}
  if (!bv || !ev) fail('version', 'could not read both versions', `bridge=${bv || '?'} extension=${ev || '?'}`);
  else if (bv !== ev) fail('version', 'bridge and extension versions differ', `bridge=${bv} extension=${ev}`);
  else info('version', `bridge and extension both ${bv}`);
}

// ---------------------------------------------------------------------------
// 2. Working tree — a release must be reproducible from the tag.
// ---------------------------------------------------------------------------
{
  const dirty = sh('git', ['status', '--porcelain']).split('\n').filter(Boolean);
  if (dirty.length) warn('git', `${dirty.length} uncommitted change(s) — commit before tagging`, dirty.slice(0, 8).join('\n'));
  else info('git', 'working tree clean');
}

// ---------------------------------------------------------------------------
// 3. Nothing ignored is also tracked. This is how state files, logs and recordings
//    leak into a public repo — the .gitignore looks right while the file is already
//    committed and ignore rules do not apply to tracked files.
// ---------------------------------------------------------------------------
{
  const bad = sh('git', ['ls-files', '--cached', '-i', '--exclude-standard']).split('\n').filter(Boolean);
  if (bad.length) fail('git', 'files are gitignored BUT tracked (ignore rules do not apply to them)', bad.join('\n'));
  else info('git', 'no ignored-but-tracked files');

  // Belt and braces: these must never be tracked regardless of ignore rules.
  const forbidden = tracked.filter((f) => /(^|\/)\.bridge-state\.json$|\.log$|(^|\/)recordings\/|(^|\/)\.env(\.|$)|(^|\/)dist\//.test(f));
  if (forbidden.length) fail('git', 'state/log/secret/build files are tracked', forbidden.join('\n'));
  else info('git', 'no state, log, .env or dist files tracked');
}

// ---------------------------------------------------------------------------
// 4. Secrets. The repo is public; a literal credential must never ship.
// ---------------------------------------------------------------------------
{
  const patterns = [
    [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, 'private key block'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style secret key'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'Anthropic API key'],
    // An assignment of a long literal to a secret-ish name. Env reads and obvious
    // placeholders are excluded to keep this signal worth reading.
    [/\b(?:api_?key|secret|password|passwd|access_?token|auth_?token)\s*[:=]\s*['"][^'"\n]{16,}['"]/i, 'hardcoded credential'],
  ];
  const skip = /^(scripts\/preflight\.mjs|.*\.(png|jpg|jpeg|gif|ico|zip|woff2?)$)/;
  const hits = [];
  for (const f of tracked) {
    if (skip.test(f)) continue;
    const text = readIf(f);
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      if (/process\.env|example|placeholder|YOUR_|<your|xxxx/i.test(line)) return;
      for (const [re, what] of patterns) if (re.test(line)) hits.push(`${f}:${i + 1}  ${what}  ${line.trim().slice(0, 100)}`);
    });
  }
  if (hits.length) fail('secrets', 'possible credential in tracked source', hits.join('\n'));
  else info('secrets', 'no credential patterns in tracked source');
}

// ---------------------------------------------------------------------------
// 5. Sensitive logging. Tokens and keys must not reach a log file a user may paste.
// ---------------------------------------------------------------------------
{
  const hits = [];
  for (const f of tracked.filter((x) => /\.(mjs|js)$/.test(x) && !x.startsWith('scripts/'))) {
    readIf(f).split('\n').forEach((line, i) => {
      if (!/console\.log|console\.error|\blog\(/.test(line)) return;
      // Logging the WORD "token" in a message is fine ("token ISSUED"); logging a token
      // VALUE is not. Strip string literals first so prose inside a message can never
      // trip this — a checker that cries wolf gets ignored, which is worse than none.
      // …and drop `!!x` / `x.length` forms, which log PRESENCE rather than content —
      // logging "was a verifier supplied?" is exactly the diagnostic you want.
      // Strip ALL string literals including template literals — otherwise prose like
      // "…never called /oauth/token" reads as a token being logged. Interpolated
      // values are covered separately by the `interpolated` check on the raw line.
      const code = line
        .replace(/`[^`]*`/g, "''")
        .replace(/'[^']*'|"[^"]*"/g, "''")
        .replace(/!!\s*[\w.$]+/g, 'BOOL')
        .replace(/\b[\w.$]+\.length\b/g, 'LEN');
      // The identifiers that actually HOLD secrets in this codebase, not a generic
      // wishlist — `access` and `refresh` are the token variables in oauth.mjs, `mac`
      // is a signature. Word-bounded so `tokenOk`/`hasSecret` don't trip it.
      const SECRET_ID = '(?:access|refresh|mac|token|secret|password|passwd|apiKey|api_key|privateKey|keyHex|pairKeyHex|code_verifier|client_secret|accessToken|refreshToken|EMBEDDED_TOKEN)';
      const interpolated = new RegExp('\\$\\{[^}]*\\b' + SECRET_ID + '\\b[^}]*\\}', 'i').test(line);
      const passedAsValue = new RegExp('\\b(?:console\\.log|console\\.error|log)\\([^)]*\\b' + SECRET_ID + '\\b').test(code);
      if (interpolated || passedAsValue) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
  if (hits.length) fail('logging', 'a secret value may be written to the log', hits.join('\n'));
  else info('logging', 'no secret values logged');
}

// ---------------------------------------------------------------------------
// 6. Network posture. Loopback is the trust boundary for the whole design.
// ---------------------------------------------------------------------------
{
  const server = readIf('bridge/server.mjs');
  const problems = [];
  if (/listen\(\s*[^,)]+,\s*['"]0\.0\.0\.0['"]/.test(server) || /HOST\s*=\s*['"]0\.0\.0\.0['"]/.test(server)) problems.push('server binds 0.0.0.0');
  if (/['"]access-control-allow-origin['"]\s*:\s*['"]\*/i.test(server)) problems.push('wildcard CORS');
  if (problems.length) fail('network', 'loopback-only posture broken', problems.join('\n'));
  else info('network', 'binds loopback, no wildcard CORS');
}

// ---------------------------------------------------------------------------
// 7. Dependencies — outdated and known-vulnerable. These ship inside the zip.
// ---------------------------------------------------------------------------
{
  const bridgeDir = join(ROOT, 'bridge');
  if (!existsSync(join(bridgeDir, 'node_modules'))) {
    warn('deps', 'bridge/node_modules missing — cannot audit (run npm install)');
  } else {
    const audit = sh('npm', ['audit', '--json', '--omit=dev'], { cwd: bridgeDir });
    try {
      const a = JSON.parse(audit);
      const v = (a.metadata && a.metadata.vulnerabilities) || {};
      const high = (v.high || 0) + (v.critical || 0);
      const low = (v.low || 0) + (v.moderate || 0);
      if (high) fail('deps', `${high} high/critical advisory(ies) in shipped dependencies`, 'run: cd bridge && npm audit');
      else if (low) warn('deps', `${low} low/moderate advisory(ies)`, 'run: cd bridge && npm audit');
      else info('deps', 'no known advisories');
    } catch { warn('deps', 'npm audit did not return JSON (offline?)'); }

    const outdated = sh('npm', ['outdated', '--json'], { cwd: bridgeDir });
    try {
      const o = JSON.parse(outdated || '{}');
      const names = Object.keys(o);
      if (names.length) warn('deps', `${names.length} dependency update(s) available`, names.map((n) => `${n}: ${o[n].current} → ${o[n].latest}`).join('\n'));
      else info('deps', 'dependencies current');
    } catch { info('deps', 'dependencies current (or offline)'); }
  }
}

// ---------------------------------------------------------------------------
// 8. Third-party surfaces we depend on at RUNTIME: the pinned Node build and the
//    GitHub release endpoints the updater uses. A silent change here breaks installs.
// ---------------------------------------------------------------------------
{
  let rt = {};
  try { rt = JSON.parse(readIf('runtime.json')); } catch {}
  if (!rt.node || !rt.repo) fail('runtime', 'runtime.json missing node/repo pin', JSON.stringify(rt));
  else {
    info('runtime', `pinned Node ${rt.node}, repo ${rt.repo}`);
    if (rt.node !== process.versions.node) {
      info('runtime', `note: building on Node ${process.versions.node}, shipping pin ${rt.node}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Stale .gitignore entries — a rule that matches nothing is either a leftover or,
//    worse, a rule someone believes is protecting a file that has since moved.
// ---------------------------------------------------------------------------
{
  const lines = readIf('.gitignore').split('\n').map((s) => s.trim());
  const stale = [];
  for (const l of lines) {
    if (!l || l.startsWith('#') || l.includes('*') || l.startsWith('!')) continue;
    // Only PATH-SPECIFIC rules are worth checking. A bare basename (node_modules/,
    // .DS_Store) is a generic protective pattern that legitimately matches nothing
    // right now; a rule naming a specific location that has vanished is the dangerous
    // case — the file it was written to protect may have moved and be unprotected.
    const body = l.replace(/\/$/, '');
    if (!body.includes('/')) continue;
    if (!existsSync(join(ROOT, body))) stale.push(l);
  }
  if (stale.length) warn('gitignore', 'rule(s) match nothing on disk — leftover, or the file moved and is now UNPROTECTED', stale.join('\n'));
  else info('gitignore', 'no stale rules');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const icon = { FAIL: '✗', WARN: '!', ok: '✓' };
let fails = 0, warns = 0;
for (const r of results) {
  if (r.level === 'FAIL') fails++;
  if (r.level === 'WARN') warns++;
  console.log(`${icon[r.level]} [${r.area}] ${r.msg}`);
  if (r.detail && r.level !== 'ok') console.log(String(r.detail).split('\n').map((l) => '    ' + l).join('\n'));
}
console.log(`\n${fails} failing, ${warns} warning, ${results.length - fails - warns} ok`);
if (fails) console.log('\nRelease BLOCKED — fix the failures above.');
process.exit(fails || (STRICT && warns) ? 1 : 0);
