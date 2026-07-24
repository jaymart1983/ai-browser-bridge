#!/usr/bin/env node
// cli.mjs — tiny command-line client for testing the bridge.
//
// Usage:
//   node cli.mjs <method> [jsonParams] [options]
//
// Options:
//   --password <pw>   Unlock first with this password, then run <method> using
//                     the returned token. Ignored for `status` and `unlock`.
//   --token <tok>     Use an existing session token for <method>.
//   --url <url>       Bridge command endpoint (default http://127.0.0.1:8787/command).
//   --raw             Print raw JSON only (no pretty framing).
//
// Examples:
//   node cli.mjs status
//   node cli.mjs unlock '{"password":"<generated>"}'
//   node cli.mjs tabs.list --token 6f1e...c9
//   node cli.mjs page.read '{"tabId":123,"format":"text"}' --password '<generated>'
//   node cli.mjs page.eval '{"tabId":123,"expression":"document.title"}' --password '<generated>'

const DEFAULT_URL = 'http://127.0.0.1:8787/command';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { method: null, params: {}, password: null, token: null, url: DEFAULT_URL, raw: false };
  let positionalConsumed = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--password') {
      out.password = args[++i];
    } else if (a === '--token') {
      out.token = args[++i];
    } else if (a === '--url') {
      out.url = args[++i];
    } else if (a === '--raw') {
      out.raw = true;
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (!out.method) {
      out.method = a;
    } else if (!positionalConsumed) {
      // Second positional is the JSON params object.
      positionalConsumed = true;
      try {
        out.params = JSON.parse(a);
      } catch (e) {
        fail(`Invalid JSON params: ${a}\n  ${e.message}`);
      }
    } else {
      fail(`Unexpected argument: ${a}`);
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

async function postCommand(url, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`Could not reach bridge at ${url} — is it running? (${e.message})`);
  }
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  return { status: resp.status, json };
}

const HELP = `browser-bridge CLI
Usage: node cli.mjs <method> [jsonParams] [--password <pw> | --token <tok>] [--url <url>] [--raw]

Methods: status, unlock, lock, tabs.list, tab.navigate, tab.create, tab.activate,
         page.read, page.eval, page.screenshot
`;

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.method) {
    process.stdout.write(HELP);
    process.exit(opts.method ? 0 : 1);
  }

  let token = opts.token;

  // Auto-unlock convenience: if a password is supplied for a method that needs
  // auth, unlock first to obtain a token.
  if (!token && opts.password && opts.method !== 'unlock' && opts.method !== 'status') {
    const { json } = await postCommand(opts.url, {
      method: 'unlock',
      params: { password: opts.password },
    });
    if (json && json.result && json.result.token) {
      token = json.result.token;
      if (!opts.raw) process.stderr.write('(auto-unlocked; token acquired)\n');
    } else {
      fail(`Auto-unlock failed: ${JSON.stringify(json && json.error ? json.error : json)}`);
    }
  }

  // Merge password into params for an explicit `unlock` call.
  const params = { ...opts.params };
  if (opts.method === 'unlock' && opts.password && params.password == null) {
    params.password = opts.password;
  }

  const body = { method: opts.method, params };
  if (token) body.token = token;

  const { status, json } = await postCommand(opts.url, body);

  if (opts.raw) {
    process.stdout.write(JSON.stringify(json) + '\n');
  } else {
    process.stdout.write(`HTTP ${status}\n`);
    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  }

  // Non-zero exit if the command produced an error.
  if (json && json.error) process.exit(2);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
