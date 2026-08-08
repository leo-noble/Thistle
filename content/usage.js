/* ============================================================
   Thistle — usage.js
   Inline session-usage bar in the composer toolbar. Positioned
   between the + button and the model picker, shows percentage,
   bar, and reset time in h/m format (no "session" label).

   Derived from Claude Counter (MIT) — see THIRD_PARTY_NOTICES.md.
   ============================================================ */

(() => {
  "use strict";

  const TH = globalThis.Thistle;
  if (!TH) return;

  let orgId = null;
  let usageBar = null;
  let pollTimer = null;

  /* Last values the bar and popup rendered. Holds both session (five_hour)
     and weekly windows, so the popup can show both without a second fetch. */
  let snapshot = { session: null, weekly: null };

  /* claude.ai keeps the org id in a cookie. Reading it is synchronous and
     always available, unlike watching API traffic for it — the org-bearing
     request usually fires before this script is injected. */
  function getOrgIdFromCookie() {
    try {
      const row = document.cookie
        .split("; ")
        .find((r) => r.startsWith("lastActiveOrg="));
      return row ? decodeURIComponent(row.split("=")[1]) || null : null;
    } catch (e) {
      return null;
    }
  }

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

  /* Wall-clock form of the same instant — "3:30 PM". Claude's own blocked
     notice says "You can use Claude again at 3:30", so once the limit is
     spent the countdown switches to this to agree with it. A duration and a
     clock time side by side reading differently is what looked broken. */
  function formatResetClock(resetAt) {
    if (!resetAt) return "";
    const at = new Date(resetAt);
    if (Number.isNaN(at.getTime())) return "";
    try {
      /* Rounded to the nearest minute, not truncated. A reset at 12:49:37
         formats as 12:49 if the seconds are simply dropped, while claude.ai
         rounds the same instant to 12:50 — so the gauge sat one minute
         behind the banner directly above it and the two disagreed. */
      const rounded = new Date(Math.round(at.getTime() / 60000) * 60000);
      return rounded.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  /* Utilization alone cannot tell you the limit is spent. The 5-hour window
     is reported as a rounded percentage and stops short of 100 — 94% was the
     last value polled while claude.ai was already refusing to send, because
     being blocked is its own flag, not utilization === 100.

     So the flag is what's tracked, and it is latched: once a source says the
     window is exceeded, every later reading renders as full until the reset
     instant passes. Without the latch the 30-second poll would immediately
     paint 94% back over it — and while you are blocked the poll is the only
     source, since the streamed event that carries the flag can only arrive
     in response to a message you are not allowed to send. */
  let limitLatch = null;

  function latchedUntil() {
    if (!limitLatch) return null;
    if (limitLatch.resetsAt && new Date(limitLatch.resetsAt).getTime() <= Date.now()) {
      limitLatch = null;
      return null;
    }
    return limitLatch;
  }

  /* Tolerant on purpose. The streamed payload names the state in `type`
     ("exceeded_limit"), while the polled one has no documented field for it;
     these are the shapes it plausibly uses, and an absent field simply means
     "no signal here" rather than "not exceeded". */
  function readExceeded(src) {
    if (!src || typeof src !== "object") return false;
    if (typeof src.type === "string" && /exceed|exhaust|reach|block/i.test(src.type)) return true;
    if (src.exceeded === true || src.exhausted === true || src.blocked === true) return true;
    if (typeof src.remaining === "number" && src.remaining <= 0) return true;
    return false;
  }

  /* The top-level resetsAt is Unix seconds where the per-window resets_at in
     the same payload is an ISO string, so it needs its own coercion. The
     threshold tells the two apart: anything below 1e12 cannot be a
     millisecond timestamp for any date this side of 2001. */
  function coerceReset(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
    if (typeof value === "string" && value) {
      const t = new Date(value);
      return Number.isNaN(t.getTime()) ? null : t.toISOString();
    }
    return null;
  }

  /* The two sources disagree on units, so both are normalised here to
     { pct, resetsAt } with pct on 0-100 and resetsAt an ISO string.

     /usage           utilization 0-100, resets_at an ISO string
     SSE message_limit utilization 0-1,  resets_at Unix seconds */
  function normalizeWindow(w, fromStream, exceeded) {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;

    const raw = fromStream ? w.utilization * 100 : w.utilization;
    const clamped = Math.max(0, Math.min(100, raw));

    /* Reaching 100 is itself the exhausted state — there is no separate flag
       still to come. Gating `spent` on an explicit flag meant the free-plan
       case never qualified, because there utilization is the entire signal:
       the gauge sat at a full bar counting down "3h 41m" while Claude's own
       banner directly above it read "out of free messages until 12:50 PM".
       Same instant, two renderings, stacked one on the other. */
    const spent = !!exceeded || readExceeded(w) || clamped >= 100;
    const pct = spent ? 100 : clamped;

    let resetsAt = null;
    if (fromStream) {
      if (typeof w.resets_at === "number" && Number.isFinite(w.resets_at)) {
        resetsAt = new Date(w.resets_at * 1000).toISOString();
      }
    } else if (typeof w.resets_at === "string") {
      resetsAt = w.resets_at;
    }

    return { pct, resetsAt, spent };
  }

  /* A fresh reading without a reset timestamp must not erase one already
     held. The two sources don't always both carry it, and a countdown that
     blanks out mid-session reads as broken. */
  function mergeWindow(prev, next) {
    if (!next) return prev;
    if (next.resetsAt || !prev) return next;
    return { pct: next.pct, resetsAt: prev.resetsAt, spent: next.spent };
  }

  /* Applied to the session window on the way to the bar. If the latch is live
     the reading is forced to full and given the latch's reset instant, which
     is the one claude.ai quotes in its own blocked notice; a reading that
     arrives already marked spent sets the latch instead. */
  function applyLatch(win) {
    if (!win) return win;

    if (win.spent) {
      limitLatch = { resetsAt: win.resetsAt || (limitLatch && limitLatch.resetsAt) || null };
      return { pct: 100, resetsAt: limitLatch.resetsAt, spent: true };
    }

    const live = latchedUntil();
    if (live) return { pct: 100, resetsAt: live.resetsAt || win.resetsAt, spent: true };

    return win;
  }

  /* Fixed positioning needs explicit left/bottom from the bar's rect —
     composer wrappers clip overflow, so absolute would be cut off.

     The width is measured, not assumed. On narrow viewports usage.css caps
     the panel at calc(100vw - 32px), so the old hardcoded 280 overstated it
     and the clamp below pushed the panel left of where it belonged, dragging
     the caret off the bar with it. */
  const POP_GAP = 12;
  const POP_EDGE = 16;

  function positionPopover(bar, popover) {
    const rect = bar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    /* Measurable only while displayed. It is opacity-0 and pointer-events
       none until [data-open], never display:none, so it has a live box. */
    const width = popover.getBoundingClientRect().width || 280;

    let left = rect.left;
    if (left + width > vw - POP_EDGE) left = vw - width - POP_EDGE;
    if (left < POP_EDGE) left = POP_EDGE;

    /* Above the bar by default. If the bar sits high enough that the panel
       would run off the top — a short mobile viewport with the keyboard up —
       flip it below and move the caret to the panel's top edge. */
    const height = popover.getBoundingClientRect().height || 0;
    const flip = rect.top - POP_GAP - height < POP_EDGE;

    popover.style.left = left + "px";
    if (flip) {
      popover.style.top = rect.bottom + POP_GAP + "px";
      popover.style.bottom = "auto";
    } else {
      popover.style.top = "auto";
      popover.style.bottom = vh - rect.top + POP_GAP + "px";
    }
    popover.toggleAttribute("data-flip", flip);

    // Caret stays on the bar's centre after the panel is clamped.
    const arrow = Math.max(
      14,
      Math.min(width - 14, rect.left + rect.width / 2 - left)
    );
    popover.style.setProperty("--th-arrow", arrow + "px");
  }

  function createBar() {
    const bar = document.createElement("div");
    bar.className = "th-usage";
    /* Percentage sits left of the bar, nearest the + button; the reset
       countdown trails it. The class is __reset, not __tip — usage.css
       styles __reset, and a stale __tip here rendered the countdown
       unstyled at the inherited size instead of dim and small.

       Every element carries a th-usage-prefixed class. base.css flattens
       plain divs inside the composer and excludes only [class*="th-usage"],
       so an unprefixed wrapper here would lose its fill and border. */
    bar.innerHTML = `
      <span class="th-usage__pct">—</span>
      <div class="th-usage__bar">
        <div class="th-usage__fill" style="width: 0%"></div>
      </div>
      <span class="th-usage__reset"></span>
      <div class="th-usage__popover">
        <div class="th-usage__limit" data-window="session">
          <span class="th-usage__limit-label">Current session</span>
          <span class="th-usage__limit-value">—</span>
          <span class="th-usage__limit-reset"></span>
        </div>
        <div class="th-usage__limit" data-window="weekly">
          <span class="th-usage__limit-label">Weekly</span>
          <span class="th-usage__limit-value">—</span>
          <span class="th-usage__limit-reset"></span>
        </div>
      </div>
    `;

    const popover = bar.querySelector(".th-usage__popover");

    /* The composer swallows stray clicks to focus the editor, so the toggle
       and the popover's own clicks both stop propagation — otherwise opening
       the popup would immediately blur it or land the caret in the prompt. */
    bar.addEventListener("click", (e) => {
      if (popover.contains(e.target)) return;
      e.stopPropagation();

      const isOpen = popover.hasAttribute("data-open");
      if (!isOpen) positionPopover(bar, popover);

      popover.toggleAttribute("data-open");
    });

    popover.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", () => {
      popover.removeAttribute("data-open");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popover.removeAttribute("data-open");
    });

    return bar;
  }

  function updatePopover() {
    if (!usageBar) return;

    const rows = [
      { key: "session", data: snapshot.session },
      { key: "weekly", data: snapshot.weekly },
    ];

    for (const row of rows) {
      const el = usageBar.querySelector(`.th-usage__limit[data-window="${row.key}"]`);
      if (!el) continue;

      const valueEl = el.querySelector(".th-usage__limit-value");
      const resetEl = el.querySelector(".th-usage__limit-reset");

      if (!row.data) {
        if (valueEl) valueEl.textContent = "—";
        if (resetEl) resetEl.textContent = "";
        continue;
      }

      if (valueEl) valueEl.textContent = Math.round(row.data.pct) + "% used";
      if (resetEl) {
        /* Three cases, in order of how much is known. Spent gets the wall
           clock and the same wording claude.ai uses, so the popup and the
           page agree. Otherwise a duration.

           At 0% the API returns no resets_at for the session — the window
           hasn't opened yet. Blank there reads as a missing value, so say
           what's actually true instead. */
        if (row.data.spent) {
          const at = formatResetClock(row.data.resetsAt);
          resetEl.textContent = at ? "You can use Claude again at " + at : "Limit reached";
        } else {
          const reset = formatResetTime(row.data.resetsAt);
          resetEl.textContent = reset
            ? "Resets in " + reset
            : "Starts with your next message";
        }
      }
    }
  }

  function updateBar(data) {
    if (!usageBar || !data) return;

    snapshot.session = applyLatch(mergeWindow(snapshot.session, data));
    const session = snapshot.session;

    const pctEl = usageBar.querySelector(".th-usage__pct");
    const fillEl = usageBar.querySelector(".th-usage__fill");
    const resetEl = usageBar.querySelector(".th-usage__reset");

    if (pctEl) pctEl.textContent = Math.round(session.pct) + "%";
    if (fillEl) {
      const width = Math.max(0, Math.min(100, session.pct));
      fillEl.style.width = width + "%";
      fillEl.toggleAttribute("data-warn", width >= 90);
    }

    /* Collapses the control once the window is spent — see usage.css. */
    usageBar.toggleAttribute("data-spent", !!session.spent);

    if (resetEl) {
      /* Bare duration, no "Resets in " prefix — the prefix cost about 55px
         of row width, which is what forced the toolbar onto a second line
         once the track grew. The full phrase is in the popup.

         Spent is the exception, and it keeps the "until". A bare "12:50 PM"
         sitting in a toolbar reads as a clock rather than a deadline; with
         the bar and the percentage hidden there is nothing left to give it
         that meaning, and the two words cost width the collapse just freed. */
      if (session.spent) {
        const at = formatResetClock(session.resetsAt);
        resetEl.textContent = at ? "until " + at : "limit reached";
      } else {
        resetEl.textContent = formatResetTime(session.resetsAt);
      }
    }

    updatePopover();
  }

  function positionBar() {
    if (!usageBar) return;

    const composer = document.querySelector('[data-th-el="composer"]');
    if (!composer) return;

    const modelPicker = composer.querySelector('[data-testid="model-selector-dropdown"]');
    if (!modelPicker) return;

    // Already in place
    if (usageBar.parentElement && modelPicker.parentElement &&
        usageBar.parentElement === modelPicker.parentElement &&
        usageBar.nextElementSibling === modelPicker) {
      return;
    }

    // Insert directly before the model picker in its parent row
    modelPicker.parentElement.insertBefore(usageBar, modelPicker);
  }

  async function poll() {
    const id = orgId || getOrgIdFromCookie();
    if (!id) return;
    try {
      const raw = await TH.bridge.requestUsage(id);
      /* While you are actually blocked this is the only live source — the
         streamed event can only arrive in reply to a message the limit is
         stopping you from sending. So the exhaustion flag has to be read
         here too, from the envelope as well as the window itself. */
      const exceeded = readExceeded(raw) || readExceeded(raw && raw.five_hour);
      if (raw && raw.five_hour) {
        const parsed = normalizeWindow(raw.five_hour, false, exceeded);
        if (parsed) {
          if (!parsed.resetsAt) {
            parsed.resetsAt = coerceReset(raw.resets_at) || coerceReset(raw.resetsAt);
          }
          updateBar(parsed);
        }
      }
      /* Weekly limit lives in the same payload. The popup shows both session
         and weekly, so we keep both in snapshot. The SSE th:limit path only
         ever carries the session window; weekly comes exclusively from poll.
         Claude Counter reads it from raw.seven_day. */
      if (raw && raw.seven_day) {
        const weekly = normalizeWindow(raw.seven_day, false);
        if (weekly) {
          snapshot.weekly = weekly;
          updatePopover();
        }
      }
    } catch (e) {
      /* best effort */
    }
  }

  function startPolling() {
    stopPolling();
    poll();
    pollTimer = setInterval(poll, 30000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function schedule() {
    requestAnimationFrame(() => {
      positionBar();
    });
  }

  async function init() {
    const injected = await TH.injectBridgeOnce();
    if (!injected) return;

    usageBar = createBar();

    /* Cookie first — it's there on load, so the bar fills on the first poll
       rather than waiting for org-bearing API traffic that may never come. */
    orgId = getOrgIdFromCookie();
    if (orgId) startPolling();

    /* Still listen, in case the cookie is missing or the org changes. */
    TH.bridge.on("th:org", (payload) => {
      if (payload && payload.orgId && payload.orgId !== orgId) {
        orgId = payload.orgId;
        startPolling();
      }
    });

    /* Streamed limit updates land mid-generation and are fresher than the
       poll, so they take precedence when they arrive.

       The payload is nested — { windows: { '5h': …, '7d': … } } — not a
       flat window. An earlier version handed the whole object to
       normalizeWindow, which looked for `utilization` at the top level,
       found nothing, and bailed every time, so this path had never once
       reached the bar. It also carries the weekly window, which the poll
       would otherwise be the only source of. */
    TH.bridge.on("th:limit", (limit) => {
      if (!limit) return;

      /* `type` and `resetsAt` sit at the top level, beside `windows` rather
         than inside it, and they are the only place the limit says it has
         actually been hit. This used to `return` the moment `windows` was
         missing, which threw away exactly the payload that mattered: the one
         announcing the limit was spent. */
      const exceeded = readExceeded(limit);
      const topReset = coerceReset(limit.resetsAt);
      const windows = limit.windows;

      if (exceeded) {
        limitLatch = { resetsAt: topReset || (limitLatch && limitLatch.resetsAt) || null };
      }

      const session = windows ? normalizeWindow(windows["5h"], true, exceeded) : null;
      if (session) {
        if (!session.resetsAt && topReset) session.resetsAt = topReset;
        updateBar(session);
      } else if (exceeded) {
        // No window breakdown, but we know the limit is gone. Say so.
        updateBar({ pct: 100, resetsAt: topReset, spent: true });
      }

      const weekly = windows ? normalizeWindow(windows["7d"], true) : null;
      if (weekly) {
        snapshot.weekly = mergeWindow(snapshot.weekly, weekly);
        updatePopover();
      }
    });

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
    });

    schedule();
  }

  TH.usageSnapshot = () => snapshot;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
