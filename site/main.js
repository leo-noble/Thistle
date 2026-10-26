/* ============================================================
   Thistle — site/main.js
   Scroll reveals, the browser tabs, copy-to-clipboard for
   chrome://extensions, and the version on the download button.
   The page is complete without it.
   ============================================================ */
(() => {
  "use strict";
  document.documentElement.classList.remove("no-js");

  // Reveal on scroll. Everything is visible already if this never runs.
  const items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.setAttribute("data-in", "");
        io.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    items.forEach((el) => io.observe(el));
  } else {
    items.forEach((el) => el.setAttribute("data-in", ""));
  }

  // Hairline under the nav once the page has moved.
  const nav = document.getElementById("nav");
  const onScroll = () => nav.toggleAttribute("data-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Firefox or Chrome. Firefox users land on the Firefox tab.
  const tabs = [...document.querySelectorAll("[data-tab]")];
  const select = (name) => {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(on));
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((t) => t.addEventListener("click", () => select(t.dataset.tab)));
  if (/firefox/i.test(navigator.userAgent)) select("firefox");

  // "Get it for Chrome" should land on the Chrome tab even if Firefox was chosen.
  document.querySelectorAll('a[href="#chrome"]').forEach((a) => a.addEventListener("click", () => select("chrome")));

  // chrome:// links can't be opened from a web page, so copy it instead.
  document.querySelectorAll(".copy").forEach((el) => {
    el.title = "Click to copy";
    el.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        el.setAttribute("data-copied", "");
        setTimeout(() => el.removeAttribute("data-copied"), 1600);
      } catch (e) {
        /* clipboard blocked; the text is right there to select */
      }
    });
  });

  // Version on the download button, from the file the package script writes.
  fetch("downloads/VERSION", { cache: "no-cache" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((v) => {
      v = v.trim();
      if (!/^\d+(\.\d+)*$/.test(v)) return;
      document.querySelectorAll("[data-version]").forEach((el) => (el.textContent = "v" + v));
    })
    .catch(() => {});
})();
