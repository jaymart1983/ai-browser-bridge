// mcp.mjs — Streamable-HTTP MCP server exposing the browser bridge as tools.
// JSON-RPC 2.0 over POST /mcp (application/json responses). Core browser tools
// forward to the extension via relay() and are gated by the rule engine
// (Source → Destination : Permission). Modules can contribute extra tools.
// Protected by OAuth (requireToken); an unauthenticated request gets a 401.

import { evaluate, toolVerb, resolveTabUrl } from './rules.mjs';
import { allModuleTools, getModuleCtx } from './modules.mjs';

const PROTOCOL_DEFAULT = '2025-06-18';
const SERVER_INFO = { name: 'browser-bridge', version: '0.2.0' };

// tool name -> { description, inputSchema, method (bridge command), map(args)->params }
const TOOLS = {
  browser_tabs_list: {
    description: "List the user's open browser tabs (id, title, favicon, url, whether enabled + its storage class).",
    inputSchema: { type: 'object', properties: {} },
    method: 'tabs.list',
  },
  browser_new_tab: {
    description: 'Open a new browser tab, optionally at a URL. Returns the new tabId.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean', description: 'focus the new tab (default false)' } } },
    method: 'tab.create',
  },
  browser_navigate: {
    description: 'Navigate an (enabled) tab to an http(s) URL.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' } }, required: ['tabId', 'url'] },
    method: 'tab.navigate',
  },
  browser_activate_tab: {
    description: 'Bring a tab to the foreground.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'tab.activate',
  },
  browser_close_tab: {
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'tab.close',
  },
  browser_read: {
    description: "Read a tab's content as text (default) or a11y tree.",
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, format: { type: 'string', enum: ['text', 'a11y'] } }, required: ['tabId'] },
    method: 'page.read',
  },
  browser_eval: {
    description: 'Run a JS expression in a tab (MAIN world). Awaits promises, so it can do same-origin fetch() with the user\'s cookies. Must return a JSON-serializable value.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, expression: { type: 'string' } }, required: ['tabId', 'expression'] },
    method: 'page.eval',
  },
  browser_screenshot: {
    description: 'Capture a PNG screenshot of the visible area of a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'page.screenshot',
  },
  browser_monitor_start: {
    description: 'Start recording a tab (network + navigations + screenshots) to a session on disk.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'monitor.start',
  },
  browser_monitor_stop: {
    description: 'Stop recording a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'monitor.stop',
  },
  browser_monitor_list: {
    description: 'List tabs currently being recorded.',
    inputSchema: { type: 'object', properties: {} },
    method: 'monitor.list',
  },
  browser_annotate: {
    description: [
      "Draw YOUR OWN notes onto a tab the user is actively browsing: a badge next to each thing you recognize, hover text with your reasoning, and optionally dim/strike its card so the user visually skips it.",
      '',
      'WORKFLOW: (1) find what is on the page — browser_read, or a recording via research_read_recording; (2) call this with one rule per item you already know about; (3) browser_screenshot to confirm it rendered.',
      '',
      'The overlay re-applies itself on navigation, SPA route changes and infinite scroll, so annotate once per tab and it keeps working as the user browses. It is ephemeral: it survives until the browser closes, never persisted. Re-push after a browser restart.',
      '',
      'Each rule needs a `key` (your id for the thing, e.g. a VIN) and a `match` telling the overlay how to find it on the page. Pick ONE matcher:',
      '  { "text": "1C4BJWFG7FL620087" }  — find this literal string in the page text. Best when the id is visible.',
      '  { "href": "/auction/15934651" }  — find links whose href contains this. USE THIS when the id is NOT rendered on screen (e.g. ACV Auctions never shows the VIN — match the auction id from the URL instead).',
      '  { "urlPattern": "*/auction/159*" } — the whole PAGE is this item; draws a page-level banner. For detail pages.',
      '  { "selector": ".listing-card[data-id=\'x\']" } — explicit CSS target.',
      '',
      'Example: [{ "key":"1C4BJWFG7FL620087", "match":{"text":"1C4BJWFG7FL620087"}, "badge":{"label":"PASS · 42","color":"#f85149","tooltip":"Canadian import · rust risk\\nPriced 14% above comps"}, "card":{"dim":true,"strike":true} }]',
      '',
      'Requires the `annotate` permission for the tab. Only text is rendered (no HTML/links).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'the tab to annotate (from browser_tabs_list)' },
        merge: { type: 'boolean', description: 'true = add to/replace by key, keeping existing rules (default). false = replace the whole set.' },
        rules: {
          type: 'array',
          description: 'one rule per item you recognize on the page',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'your stable id for this item (e.g. the VIN); echoed back to you' },
              match: {
                type: 'object',
                description: 'how to find it on the page — set exactly one of text/href/urlPattern/selector',
                properties: {
                  text: { type: 'string' }, href: { type: 'string' },
                  urlPattern: { type: 'string' }, selector: { type: 'string' },
                },
              },
              badge: {
                type: 'object',
                description: 'the chip drawn next to the match',
                properties: {
                  label: { type: 'string', description: 'short text, e.g. "PASS · 42"' },
                  color: { type: 'string', description: 'CSS color for the chip, e.g. "#f85149"' },
                  tooltip: { type: 'string', description: 'your full reasoning, shown on hover. Newlines allowed.' },
                },
              },
              card: {
                type: 'object',
                description: "styling for the match's enclosing listing card",
                properties: { dim: { type: 'boolean' }, strike: { type: 'boolean' }, hide: { type: 'boolean' } },
              },
              cardSelector: { type: 'string', description: 'optional CSS selector for the card ancestor, if the automatic guess is wrong' },
            },
            required: ['key', 'match'],
          },
        },
      },
      required: ['tabId', 'rules'],
    },
    method: 'overlay.set',
  },
  browser_annotate_clear: {
    description: 'Remove annotations you drew on a tab. Pass `keys` to remove specific ones, or omit to clear the whole tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['tabId'] },
    method: 'overlay.clear',
  },
  browser_annotate_list: {
    description: "Show which of YOUR annotations are currently on a tab and which are visible on screen right now — useful to confirm a rule matched. Reports only your own rules; it does not read page content (use browser_read for that).",
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] },
    method: 'overlay.list',
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > 8_000_000) { req.destroy(); resolve(null); return; } b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || 'null')); } catch { resolve(undefined); } });
    req.on('error', () => resolve(null));
  });
}
function send(res, status, obj, headers) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(headers || {}) });
  res.end(body);
}
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(msg, ctx) {
  const { relay } = ctx;
  const { id, method, params } = msg || {};
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return id != null ? rpcError(id ?? null, -32600, 'Invalid Request') : null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_DEFAULT,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      const tools = { ...TOOLS, ...allModuleTools() };
      return rpcResult(id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    }
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const core = TOOLS[name];
      const moduleTool = core ? null : allModuleTools()[name];
      if (!core && !moduleTool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        // Module-provided tool: runs in the bridge, allowed because its module is
        // enabled and the agent is OAuth-authorized (no browser target to gate).
        if (moduleTool) {
          const out = await moduleTool.handler(args, getModuleCtx());
          // A module tool may return rich MCP content (e.g. an image) via __mcpContent;
          // otherwise its return value is serialized as text.
          if (out && typeof out === 'object' && Array.isArray(out.__mcpContent)) {
            return rpcResult(id, { content: out.__mcpContent, ...(out.isError ? { isError: true } : {}) });
          }
          return rpcResult(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
        }

        // Core browser tool: enforce (Source → Destination : Permission).
        let targetUrl = null;
        if (name === 'browser_navigate' || name === 'browser_new_tab') targetUrl = args.url || null;
        else if (typeof args.tabId === 'number') targetUrl = await resolveTabUrl(args.tabId);
        const decision = evaluate(ctx.sourceName, targetUrl, name);
        if (!decision.allow) {
          return rpcResult(id, { content: [{ type: 'text', text: `Blocked by policy: ${decision.reason}` }], isError: true });
        }

        const result = await relay(core.method, args);

        // browser_tabs_list → filter to tabs the source may read; drop ext-owned fields.
        if (name === 'browser_tabs_list' && Array.isArray(result)) {
          const allowed = result
            .filter((t) => evaluate(ctx.sourceName, t.url || '', 'browser_read').allow)
            .map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, favIconUrl: t.favIconUrl, active: t.active }));
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(allowed, null, 2) }] });
        }
        // Screenshot → image content; everything else → JSON text.
        if (name === 'browser_screenshot' && result && typeof result.dataUrl === 'string') {
          const m = /^data:(image\/\w+);base64,(.*)$/.exec(result.dataUrl);
          if (m) return rpcResult(id, { content: [{ type: 'image', data: m[2], mimeType: m[1] }] });
        }
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${String((e && e.message) || e)}` }], isError: true });
      }
    }
    default:
      return id != null ? rpcError(id, -32601, `Method not found: ${method}`) : null;
  }
}

// Returns true if it handled the request.
export async function mcpHandle(req, res, url, ctx) {
  if (url.pathname !== '/mcp') return false;
  if (req.method === 'GET') { send(res, 405, { error: 'Use POST for JSON-RPC' }, { allow: 'POST' }); return true; }
  if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return true; }

  // OAuth gate — an unauthenticated call advertises where to authenticate.
  const grant = ctx.requireToken(req.headers.authorization, req);
  if (!grant) { send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': ctx.wwwAuthenticate(req) }); return true; }

  // The Source for the rule engine = the agent's registered client_name.
  const rctx = { ...ctx, sourceName: grant.name };

  const body = await readBody(req);
  if (body === undefined) { send(res, 400, rpcError(null, -32700, 'Parse error')); return true; }

  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await dispatch(m, rctx); if (r) out.push(r); }
    send(res, 200, out.length ? out : undefined, out.length ? undefined : undefined);
    return true;
  }
  const reply = await dispatch(body, rctx);
  if (reply == null) { send(res, 202, undefined); return true; } // notification
  send(res, 200, reply); return true;
}
