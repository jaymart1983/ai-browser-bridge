// content.js
//
// NOTE: This extension deliberately does NOT register a persistent content
// script in manifest.json. Page reads/evals are performed on demand via
// chrome.scripting.executeScript from the service worker (see doPageRead /
// doPageEval in background.js). That approach:
//   * requires no always-on injected code (smaller attack surface),
//   * runs only when an authenticated, gated command asks for it, and
//   * can target the MAIN world for page.eval.
//
// This file is kept as a documented, reusable DOM-read helper in case a future
// version wants to inject a content script (e.g. for streaming DOM mutations).
// It is standalone and side-effect-free when merely loaded.

/**
 * Extract page content in the requested format.
 * @param {'text'|'html'} format
 * @returns {string}
 */
function readPageContent(format) {
  if (format === 'html') {
    return document.documentElement.outerHTML;
  }
  return document.body ? document.body.innerText : '';
}

// Export for potential programmatic injection (executeScript {func}) or module
// import. Guarded so loading in a plain page context does not throw.
if (typeof globalThis !== 'undefined') {
  globalThis.__aiBridgeReadPageContent = readPageContent;
}
