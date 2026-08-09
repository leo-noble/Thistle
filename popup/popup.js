/* ============================================================
   Thistle — popup.js
   ============================================================ */

/* Firefox defines `chrome` too, but only as a callback-style alias — its
   methods return undefined rather than a promise. Every `await api.…`
   below then resolved to undefined and the destructures threw, which took
   the whole popup down on Firefox: no toggle, no usage, no transfer, no
   export. `browser` is the promise-based namespace and only Firefox has it,
   so preferring it yields promises in both browsers. */
const api = globalThis.browser || globalThis.chrome;

const el = {
  themeToggle: document.getElementById("themeToggle"),
  statusDot: document.getElementById("statusDot"),
  usageLabel: document.getElementById("usageLabel"),
  usageReset: document.getElementById("usageReset"),
  usageFill: document.getElementById("usageFill"),
  usageNote: document.getElementById("usageNote"),
  usageCard: document.getElementById("usageCard"),
  contextHint: document.getElementById("contextHint"),
  toast: document.getElementById("toast"),
  tabCards: Array.from(document.querySelectorAll("[data-needs-tab]")),
};

const TARGETS = {
  chatgpt: { label: "ChatGPT", url: "https://chatgpt.com/", host: "chatgpt.com" },
  gemini: { label: "Gemini", url: "https://gemini.google.com/app", host: "gemini.google.com" },
  grok: { label: "Grok", url: "https://grok.com/", host: "grok.com" },
};

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
   quote the same time rather than three different renderings of it. */
function formatResetClock(resetAt) {
  if (!resetAt) return "";
  const at = new Date(resetAt);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

/* The page hands back the whole snapshot — { session, weekly } — not a bare
   window, so the 5-hour window has to be unwrapped. Reading .pct off the
   wrapper found undefined every time and the panel sat on "No data yet"
   however much usage the in-page gauge was reporting. */
function renderUsage(snap) {
  const session = snap && snap.session;

  if (!session || typeof session.pct !== "number") {
    el.usageNote.textContent = "No data yet";
    el.usageLabel.textContent = "0%";
    el.usageReset.textContent = "";
    el.usageFill.style.width = "0%";
    el.usageFill.removeAttribute("data-warn");
    return;
  }

  const pct = Math.round(session.pct);
  const width = Math.max(0, Math.min(100, pct));
  el.usageFill.style.width = width + "%";
  el.usageFill.toggleAttribute("data-warn", width >= 90);
  el.usageLabel.textContent = pct + "%";

  /* Spent shows the wall clock, matching the wording claude.ai puts on the
     page and the in-page gauge's own popup. A countdown there would be
     answering a question the user isn't asking. */
  if (session.spent) {
    const at = formatResetClock(session.resetsAt);
    el.usageReset.textContent = at || "";
    el.usageNote.textContent = at
      ? "Limit reached · you can use Claude again at " + at
      : "Limit reached for this 5-hour window";
    return;
  }

  el.usageReset.textContent = session.resetsAt ? formatResetTime(session.resetsAt) : "";
  el.usageNote.textContent = pct + "% of the 5-hour window used";
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

async function refreshAvailability() {
  const tab = await activeTab();

  if (!isClaudeTab(tab)) {
    el.tabCards.forEach((card) => card.setAttribute("data-disabled", ""));
    hint("Open a claude.ai tab to export", true);
    renderUsage(null);
    return;
  }

  const result = await callPage(tab.id, "stats");
  el.tabCards.forEach((card) => card.removeAttribute("data-disabled"));

  if (!result.ok) {
    el.tabCards.forEach((card) => card.setAttribute("data-disabled", ""));
    hint("Reload the Claude tab to export", true);
    renderUsage(null);
    return;
  }

  const { turns, words } = result.value || { turns: 0, words: 0 };

  /* Say the size up front. Both actions are all-or-nothing on the whole
     transcript, and a 40k-word chat pasted into another tab is a surprise
     worth having before the click rather than after.

     Kept short enough to hold one line at 288px — the format is already in
     the section label and both button tooltips. */
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

  /* The page returns the filename it used. The download itself is triggered
     page-side — a blob URL made here dies the instant the popup closes — so
     this is the only way to name the file in the confirmation. */
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

el.themeToggle.addEventListener("change", () => {
  const enabled = el.themeToggle.checked;
  api.storage.local.set({ thEnabled: enabled });
  el.statusDot.toggleAttribute("data-off", !enabled);
  toast(enabled ? "Enabled" : "Paused");
});

(async function init() {
  const stored = await api.storage.local.get(["thEnabled"]);
  const enabled = !stored || stored.thEnabled !== false;

  el.themeToggle.checked = enabled;
  el.statusDot.toggleAttribute("data-off", !enabled);

  refreshAvailability();
})();
