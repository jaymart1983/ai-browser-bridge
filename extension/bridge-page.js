// bridge-page.js — content script on the bridge's own control panel.
//
// WHY THIS EXISTS. Approving an agent must prove a HUMAN did it. The bridge's web UI
// is loopback-only but unauthenticated, so a plain POST from that page is not proof —
// any local process could send the same request. The only proof is a signature made
// with the browser↔bridge pairing key, which lives in the extension's service worker
// and never leaves it.
//
// So the control panel doesn't approve anything itself: it asks THIS script, which
// asks the service worker to sign and submit. The page gets working Approve/Deny
// buttons; the security property is unchanged, because the signature still comes from
// a paired browser.
//
// The service worker independently verifies that the sender's origin really is the
// configured bridge (sender.origin, which a page cannot forge), so a different local
// server cannot borrow this relay to approve itself.

(() => {
  const TAG = 'browser-bridge';

  // Tell the page the extension is here, so it can show real buttons instead of
  // "approve in the popup". Announce on load and on request (the page may load first).
  const announce = () => window.postMessage({ source: 'bb-ext', type: 'present' }, location.origin);

  window.addEventListener('message', async (ev) => {
    // Only messages from this very page — never from an iframe or another origin.
    if (ev.source !== window || ev.origin !== location.origin) return;
    const m = ev.data;
    if (!m || m.source !== 'bb-page') return;

    if (m.type === 'ping') { announce(); return; }

    // Start pairing from the settings page. The key is still generated in the service
    // worker and never leaves it; the page only asks.
    if (m.type === 'link') {
      let res;
      try { res = await chrome.runtime.sendMessage({ type: 'PAGE_LINK' }); }
      catch (e) { res = { ok: false, error: 'The ' + TAG + ' extension did not respond. Reload it and try again.' }; }
      window.postMessage({ source: 'bb-ext', type: 'link-result', result: res || { ok: false } }, location.origin);
      return;
    }

    if (m.type !== 'decision') return;

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'PAGE_DECISION',
        kind: m.kind === 'module' ? 'module' : 'oauth',
        reqId: String(m.reqId || ''),
        approve: !!m.approve,
      });
    } catch (e) {
      res = { ok: false, error: 'The ' + TAG + ' extension did not respond. Reload it and try again.' };
    }
    window.postMessage({ source: 'bb-ext', type: 'decision-result', reqId: m.reqId, result: res || { ok: false } }, location.origin);
  });

  announce();
})();
