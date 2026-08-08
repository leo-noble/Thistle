/* ============================================================
   Thistle — apply-theme.js
   Sets the attribute every rule in base.css keys off.

   Runs at document_start. chrome.storage is async, so the attribute
   is set optimistically first and corrected once the real value
   arrives — otherwise claude.ai paints its own palette for a frame
   and the page visibly flashes white on every load.
   ============================================================ */

(function () {
  "use strict";

  const root = document.documentElement;
  const KEY = "thEnabled";

  // Guards the observer below: our own writes must not be treated as
  // the page stripping the attribute.
  let restoring = false;

  let enabled = true;

  function apply() {
    restoring = true;
    if (enabled) {
      root.setAttribute("data-th-theme", "on");
    } else {
      root.removeAttribute("data-th-theme");
    }
    restoring = false;
  }

  // Optimistic: default is theme on.
  apply();

  /* local, not sync. An unpacked extension gets a fresh ID per machine, so
     synced settings would never find their way back to the same extension
     anyway — and Firefox refuses storage.sync outright unless the manifest
     declares a gecko add-on ID. */
  chrome.storage.local.get([KEY], (stored) => {
    enabled = !stored || stored[KEY] !== false;
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    enabled = changes[KEY].newValue !== false;
    apply();
  });

  /* claude.ai rewrites <html>'s attributes on client-side route
     changes and can drop ours with them. Put it back, or the skin
     falls off mid-session and only a reload brings it back. */
  new MutationObserver(() => {
    if (restoring) return;
    if (root.hasAttribute("data-th-theme") !== enabled) apply();
  }).observe(root, {
    attributes: true,
    attributeFilter: ["data-th-theme", "class"],
  });
})();
