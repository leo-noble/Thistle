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

  /* Every target composer is a framework-owned editor — ProseMirror on
     ChatGPT, Quill on Gemini, a React-controlled textarea on Grok — and none
     of them watch the DOM for writes they did not make. Assigning
     textContent painted the text but left the editor's own model empty, so
     the send button stayed disabled and the first keystroke wiped the paste.

     insertText goes through the browser's editing pipeline and arrives as a
     real beforeinput/input pair, which is what all three listen to. It is
     deprecated in name only; nothing has replaced it for this. The direct
     writes are kept as the fallback for an editor that refuses it. */
  function typeText(el, text) {
    el.focus();

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.select();
      if (document.execCommand && document.execCommand("insertText", false, text) && el.value) return;
      /* React tracks a textarea's value through the prototype setter, so
         an own-property write is invisible to it. */
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand && document.execCommand("insertText", false, text) && el.textContent.trim()) return;
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 40; // ~20s at 500ms — these apps mount slowly

  async function run() {
    // storage hangs off the extension namespace, not off runtime.
    const api = globalThis.browser || globalThis.chrome;
    if (!api || !api.storage) return;

    try {
      /* The promise form. Firefox's `browser` namespace never calls a
         callback, so the old callback form hung there and nothing was ever
         pasted; MV3 Chrome returns a promise from the same call. */
      const stored = (await api.storage.local.get([STORAGE_KEY])) || {};

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

      /* Claimed before typing, not after. A second run — the page's own
         navigation re-running this script — would otherwise paste it twice. */
      await api.storage.local.remove([STORAGE_KEY]);
      typeText(composer, payload.text);
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
