/* ============================================================
   Thistle — popup.js
   ============================================================ */

/* Firefox defines `chrome` too, but only as a callback-style alias — its
   methods return undefined rather than a promise. Every `await api.…`
   below then resolved to undefined and the destructures threw, which took
   the whole popup down on Firefox: no usage, no transfer, no export.
   `browser` is the promise-based namespace and only Firefox has it, so
   preferring it yields promises in both browsers. */
const api = globalThis.browser || globalThis.chrome;

const el = {
  statusDot: document.getElementById("statusDot"),
  usageStatus: document.getElementById("usageStatus"),
  usageRing: document.getElementById("usageRing"),
  usagePct: document.getElementById("usagePct"),
  usageWhat: document.getElementById("usageWhat"),
  usageReset: document.getElementById("usageReset"),
  contextHint: document.getElementById("contextHint"),
  toast: document.getElementById("toast"),
  tabCards: Array.from(document.querySelectorAll("[data-needs-tab]")),
};

const TARGETS = {
  chatgpt: { label: "ChatGPT", url: "https://chatgpt.com/", host: "chatgpt.com" },
  gemini: { label: "Gemini", url: "https://gemini.google.com/app", host: "gemini.google.com" },
  grok: { label: "Grok", url: "https://grok.com/", host: "grok.com" },
};

/* Ring geometry. Deliberately identical to content/usage.js — r=8 in a
   20x20 box, dasharray pinned to the circumference so a single dashoffset
   drives the sweep — because the popup and the in-page gauge are two
   renderings of one reading, and a ring that swept differently in each
   would read as two different meters. */
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

el.usageRing.setAttribute("stroke-dasharray", String(RING_C));
el.usageRing.setAttribute("stroke-dashoffset", String(RING_C));

function formatResetTime(resetAt) {
  if (!resetAt) return "";
  const diffMs = new Date(resetAt).getTime() - Date.now();
  if (diffMs <= 0) return "0m";
  const totalMin = Math.round(diffMs / 60000);
  if (totalMin < 60) return totalMin + "m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h + "h " + m + "m";
}

/* Wall-clock form of the same instant. Mirrors the helper in content/usage.js
   so the popup, the in-page gauge, and claude.ai's own blocked notice all
   quote the same time rather than three different renderings of it — which
   means rounding to the nearest minute rather than truncating, or a reset at
   12:49:37 reads 12:49 here against claude.ai's own 12:50. */
function formatResetClock(resetAt) {
  if (!resetAt) return "";
  const at = new Date(resetAt);
  if (Number.isNaN(at.getTime())) return "";
  try {
    const rounded = new Date(Math.round(at.getTime() / 60000) * 60000);
    return rounded.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function drawRing(pct) {
  const shown = Math.max(0, Math.min(100, pct));
  /* A sliver stays drawn at 0% so the ring reads as empty rather than as
     broken. With round caps that lands as a single dot at twelve o'clock. */
  const swept = Math.max(shown, 1.5) / 100;
  el.usageRing.setAttribute("stroke-dashoffset", String(RING_C * (1 - swept)));
  el.usageRing.toggleAttribute("data-warn", shown >= 90);
}

/* The page hands back the whole snapshot — { session, weekly } — not a bare
   window, so the 5-hour window has to be unwrapped. Reading .pct off the
   wrapper found undefined every time and the panel sat on "No data yet"
   however much usage the in-page gauge was reporting.

   The weekly window goes in the row's tooltip. There is room on the status
   line for one ring, and the 5-hour window is the one that governs the next
   message — but the weekly figure is in the same payload and dropping it
   outright would be throwing away a reading we already hold. */
function renderUsage(snap) {
  const session = snap && snap.session;
  const weekly = snap && snap.weekly;

  el.usageStatus.title = weekly && typeof weekly.pct === "number"
    ? "Weekly: " + Math.round(weekly.pct) + "% used"
    : "";

  if (!session || typeof session.pct !== "number") {
    el.usageStatus.removeAttribute("data-spent");
    el.usagePct.textContent = "—";
    el.usageWhat.textContent = "no data yet";
    el.usageReset.textContent = "";
    drawRing(0);
    return;
  }

  const pct = Math.round(session.pct);
  drawRing(session.pct);

  /* Spent shows the wall clock and the wording claude.ai puts on the page,
     so the popup and the page agree. A countdown there would be answering a
     question the user isn't asking. */
  if (session.spent) {
    el.usageStatus.setAttribute("data-spent", "");
    const at = formatResetClock(session.resetsAt);
    el.usageReset.textContent = at
      ? "Limit reached · back at " + at
      : "Limit reached for this session";
    return;
  }

  el.usageStatus.removeAttribute("data-spent");
  el.usagePct.textContent = pct + "%";
  el.usageWhat.textContent = "session used";

  /* At 0% the API returns no resets_at — the window hasn't opened yet.
     Blank there reads as a missing value, so say what's actually true. */
  const reset = formatResetTime(session.resetsAt);
  el.usageReset.textContent = reset ? "resets in " + reset : "starts with your next message";
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isClaudeTab(tab) {
  return !!tab && typeof tab.url === "string" && /^https:\/\/claude\.ai\//.test(tab.url);
}

async function callPage(tabId, fnName, arg) {
  const [entry] = await api.scripting.executeScript({
    target: { tabId },
    args: [fnName, arg ?? null],
    /* Serialized and re-parsed in the tab, so it closes over nothing here —
       `page` is content/export.js's own surface, not the extension API. */
    func: (name, param) => {
      const page = globalThis.__thistle;
      if (!page || typeof page[name] !== "function") return { ok: false, reason: "unavailable" };
      try {
        return Promise.resolve(param === null ? page[name]() : page[name](param))
          .then((value) => ({ ok: true, value }))
          .catch(() => ({ ok: false, reason: "error" }));
      } catch (e) {
        return { ok: false, reason: "error" };
      }
    },
  });
  return (entry && entry.result) || { ok: false, reason: "unavailable" };
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, { position: "fixed", top: "-1000px", opacity: "0" });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e2) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("is-on"), 2000);
}

function flash(btn) {
  btn.classList.add("is-done");
  setTimeout(() => btn.classList.remove("is-done"), 1200);
}

async function withBusy(btn, task) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await task();
  } finally {
    btn.disabled = false;
  }
}

function hint(message, warn) {
  el.contextHint.textContent = message;
  el.contextHint.toggleAttribute("data-warn", !!warn);
}

/* The header dot reports whether there is a claude.ai tab to act on. It used
   to report whether the theme was switched on; the theme is gone, and this
   is the one piece of state the whole panel depends on. */
function setConnected(connected, why) {
  el.statusDot.toggleAttribute("data-off", !connected);
  el.statusDot.title = why;
}

async function refreshAvailability() {
  const tab = await activeTab();

  if (!isClaudeTab(tab)) {
    el.tabCards.forEach((card) => card.setAttribute("data-disabled", ""));
    setConnected(false, "No claude.ai tab");
    hint("Open a claude.ai tab to export", true);
    renderUsage(null);
    return;
  }

  const result = await callPage(tab.id, "stats");

  if (!result.ok) {
    el.tabCards.forEach((card) => card.setAttribute("data-disabled", ""));
    setConnected(false, "Reload the Claude tab");
    hint("Reload the Claude tab to export", true);
    renderUsage(null);
    return;
  }

  el.tabCards.forEach((card) => card.removeAttribute("data-disabled"));
  setConnected(true, "Connected to claude.ai");

  const { turns, words } = result.value || { turns: 0, words: 0 };

  /* Say the size up front. Both actions are all-or-nothing on the whole
     transcript, and a 40k-word chat pasted into another tab is a surprise
     worth having before the click rather than after.

     Kept short enough to hold one line — the format is already in the
     section label and both button tooltips. */
  if (!turns) {
    hint("Nothing to export yet", false);
  } else {
    hint(
      turns + (turns === 1 ? " message · " : " messages · ") +
        words.toLocaleString() + " words",
      false
    );
  }

  const usageRes = await callPage(tab.id, "usage");
  renderUsage(usageRes.ok ? usageRes.value : null);
}

async function runTransfer(btn, target) {
  const spec = TARGETS[target];
  const tab = await activeTab();
  if (!isClaudeTab(tab)) return toast("Open a claude.ai tab");

  const result = await callPage(tab.id, "getText", target);
  if (!result.ok) return toast("Reload the Claude tab");
  if (!result.value) return toast("Nothing to transfer");

  const copied = await copyToClipboard(result.value);

  let handed = false;
  try {
    await api.storage.local.set({
      thTransfer: { text: result.value, at: Date.now(), host: spec.host },
    });
    handed = true;
  } catch (e) {
    handed = false;
  }

  if (!copied && !handed) return toast("Transfer failed");

  flash(btn);
  await api.tabs.create({ url: spec.url });
  toast(handed ? "Opening " + spec.label : "Copied");
}

async function runCopy(btn) {
  const tab = await activeTab();
  if (!isClaudeTab(tab)) return toast("Open a claude.ai tab");

  const result = await callPage(tab.id, "getText", "markdown");
  if (!result.ok) return toast("Reload the Claude tab");
  if (!result.value) return toast("Nothing to export");

  const copied = await copyToClipboard(result.value);
  if (!copied) return toast("Clipboard blocked");

  flash(btn);
  toast("Copied " + result.value.length.toLocaleString() + " chars");
  hint("Copied to clipboard as Markdown", false);
}

async function runDownload(btn) {
  const tab = await activeTab();
  if (!isClaudeTab(tab)) return toast("Open a claude.ai tab");

  /* The download runs page-side — a blob URL made here dies the instant the
     popup closes — so the returned filename is the only way to name the file
     in the confirmation. */
  const result = await callPage(tab.id, "download");
  if (!result.ok) return toast("Reload the Claude tab");
  if (!result.value) return toast("Nothing to export");

  const name = typeof result.value === "string" ? result.value : null;

  flash(btn);
  toast(name ? "Saved " + name : "Download started");
  hint(name ? "Saved as " + name : "Download started", false);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-transfer], button[data-copy], button[data-download]");
  if (!btn) return;

  if (btn.dataset.transfer) return withBusy(btn, () => runTransfer(btn, btn.dataset.transfer));
  if (btn.dataset.copy) return withBusy(btn, () => runCopy(btn));
  return withBusy(btn, () => runDownload(btn));
});

refreshAvailability();
