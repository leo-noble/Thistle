/* ============================================================
   Thistle — receiver.js
   Runs on ChatGPT, Gemini, Grok. Checks storage for a transfer
   payload, types it into the composer, then clears it.
   ============================================================ */

(() => {
  "use strict";

  const HOST = location.host;
  const STORAGE_KEY = "thTransfer";
  const MAX_AGE_MS = 60000;

  const SELECTORS = {
    "chatgpt.com": "textarea, [contenteditable=true]",
    "chat.openai.com": "textarea, [contenteditable=true]",
    "gemini.google.com": "[contenteditable=true], textarea",
    "grok.com": "textarea, [contenteditable=true]",
  };

  function findComposer() {
    const sel = SELECTORS[HOST];
    if (!sel) return null;
    const all = document.querySelectorAll(sel);
    let best = null;
    let bestBottom = -Infinity;
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 120) continue;
      if (rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        best = el;
      }
    }
    return best;
  }

  function typeText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 40; // ~20s at 500ms — these apps mount slowly

  async function run() {
    // storage hangs off the extension namespace, not off runtime.
    const api = globalThis.browser || globalThis.chrome;
    if (!api || !api.storage) return;

    try {
      const stored = await new Promise((resolve) => {
        api.storage.local.get([STORAGE_KEY], (result) => resolve(result || {}));
      });

      const payload = stored[STORAGE_KEY];
      if (!payload || !payload.text || payload.host !== HOST) return;

      const age = Date.now() - (payload.at || 0);
      if (age > MAX_AGE_MS) {
        api.storage.local.remove([STORAGE_KEY]);
        return;
      }

      const composer = findComposer();
      if (!composer) {
        // The payload is claimed by host, so a page that never mounts a
        // composer must give up rather than retry forever.
        attempts += 1;
        if (attempts < MAX_ATTEMPTS) setTimeout(run, 500);
        return;
      }

      typeText(composer, payload.text);
      composer.focus();
      api.storage.local.remove([STORAGE_KEY]);
    } catch (e) {
      /* best effort */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    setTimeout(run, 300);
  }
})();
