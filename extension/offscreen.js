// offscreen.js
//
// Runs inside the hidden offscreen document. Its ONLY jobs are:
//   1. Maintain a persistent WebSocket to the local bridge (with backoff
//      auto-reconnect).
//   2. For each command frame received over the WS, hand it to the service
//      worker (which owns all auth + execution) and write the reply back.
//
// This document has NO authority: it never validates the access code and never
// touches chrome.tabs/scripting. It is a dumb, resilient pipe. Keeping all trust
// decisions in the service worker means a compromised page or bridge cannot
// escalate through the socket without a valid access code.

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787/agent';

let bridgeUrl = DEFAULT_BRIDGE_URL;
let ws = null;
let reconnectTimer = null;
let backoffMs = 500; // grows to a cap on repeated failures
const BACKOFF_MAX = 15000;

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------
function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  // Avoid stacking sockets.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(bridgeUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', async () => {
    backoffMs = 500; // reset backoff on a good connection
    notifyStatus(true);
    // Announce ourselves + WHICH browser we are, so the bridge can map this socket
    // to a linked browser (and route/activate correctly with several linked).
    let ident = {};
    try { ident = await chrome.storage.local.get(['browserId', 'browserName']); } catch {}
    safeSend({ type: 'hello', role: 'extension', version: chrome.runtime.getManifest().version, browserId: ident.browserId || null, browserName: ident.browserName || null });
  });

  ws.addEventListener('message', (ev) => {
    onWsMessage(ev.data);
  });

  ws.addEventListener('close', () => {
    notifyStatus(false);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'error' is always followed by 'close'; let close handle reconnect.
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
}

function safeSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      /* fallthrough */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inbound command frames from the bridge -> service worker -> reply
// ---------------------------------------------------------------------------
async function onWsMessage(raw) {
  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    safeSend({ id: null, error: { code: 'BAD_JSON', message: 'Malformed JSON frame.' } });
    return;
  }

  // Control frames from the bridge (non-command).
  if (!cmd || typeof cmd !== 'object' || typeof cmd.method !== 'string') {
    // Pairing handshake reply → hand to the SW to finish key derivation.
    if (cmd && cmd.type === 'pair_ack') {
      chrome.runtime.sendMessage({ type: 'PAIR_ACK', pub: cmd.pub }).catch(() => {});
      return;
    }
    // Pending-auth count → hand to the SW to badge the toolbar icon.
    if (cmd && cmd.type === 'pending') {
      chrome.runtime.sendMessage({ type: 'PENDING', count: cmd.count | 0 }).catch(() => {});
      return;
    }
    // Bridge self-updated the extension source → reload to pick up new code.
    if (cmd && cmd.type === 'reload_extension') {
      chrome.runtime.sendMessage({ type: 'RELOAD_EXTENSION' }).catch(() => {});
      return;
    }
    if (cmd && cmd.type) return; // other hello/ack frames — no reply
    safeSend({ id: cmd && cmd.id, error: { code: 'BAD_REQUEST', message: 'Missing method.' } });
    return;
  }

  try {
    // Forward to the SW; this also wakes it if suspended.
    const reply = await chrome.runtime.sendMessage({ type: 'BRIDGE_COMMAND', payload: cmd });
    safeSend(reply);
  } catch (e) {
    safeSend({
      id: cmd.id,
      error: { code: 'SW_UNAVAILABLE', message: String((e && e.message) || e) },
    });
  }
}

function notifyStatus(connected) {
  chrome.runtime.sendMessage({ type: 'WS_STATUS', connected }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Control messages from the service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'CONFIG':
      if (msg.bridgeUrl && msg.bridgeUrl !== bridgeUrl) {
        bridgeUrl = msg.bridgeUrl;
        // Force a fresh connection to the new URL.
        try {
          if (ws) ws.close();
        } catch {
          /* ignore */
        }
        backoffMs = 500;
        connect();
      } else if (msg.bridgeUrl) {
        bridgeUrl = msg.bridgeUrl;
        connect();
      }
      return;

    case 'PING':
      // Keepalive from the SW alarm: make sure the socket is alive.
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connect();
      }
      sendResponse({ pong: true, connected: !!(ws && ws.readyState === WebSocket.OPEN) });
      return; // sync response

    case 'WS_SEND':
      // Unsolicited event frame (e.g. monitor_event) from the SW -> bridge.
      if (msg.frame) safeSend(msg.frame);
      return;

    default:
      return;
  }
});

// Kick off the connection as soon as the document loads.
connect();
