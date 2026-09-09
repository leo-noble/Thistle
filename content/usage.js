/* ============================================================
   Thistle — usage.js
   Inline session-usage gauge in the composer's control row, sitting
   immediately left of the dictation button. A small ring, the
   percentage, and the reset time in h/m format; click it for the
   session and weekly breakdown.

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

  /* Built node by node rather than from an HTML string. Nothing here is
     user-supplied, so innerHTML would have been safe — but Mozilla's
     add-on linter flags every innerHTML assignment it sees, and a review
     warning is not worth saving twelve lines. */
  function span(className, text) {
    const node = document.createElement("span");
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function div(className) {
    const node = document.createElement("div");
    node.className = className;
    return node;
  }

  /* SVG needs createElementNS. document.createElement("svg") yields an
     HTMLUnknownElement that lays out as an inline box and paints nothing —
     no error, just an invisible gauge. And `class` has to be set through
     setAttribute: on an SVG element .className is a read-only
     SVGAnimatedString, so assigning to it silently does nothing. */
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svg(tag, className) {
    const node = document.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    return node;
  }

  /* Ring geometry, matching the context meter in the Claude Code app.

     r=8 in a 20x20 box leaves room for the 2.5px stroke without clipping:
     a stroke straddles its path, so the outer edge lands at 8 + 1.25 =
     9.25 against a half-box of 10.

     The circumference is precomputed because it is the whole mechanism —
     stroke-dasharray is pinned to it so a single dashoffset drives how much
     of the circle is drawn, from the full circumference (empty) down to
     zero (complete). One animatable number, which is what lets the sweep
     transition smoothly; a conic-gradient would have needed @property to
     interpolate at all. */
  const RING_R = 8;
  const RING_C = 2 * Math.PI * RING_R;

  function createRing() {
    const ring = svg("svg", "th-usage__ring");
    ring.setAttribute("viewBox", "0 0 20 20");
    /* The percentage beside it already says this out loud, and a decorative
       ring announcing itself twice is worse than not at all. */
    ring.setAttribute("aria-hidden", "true");

    const track = svg("circle", "th-usage__ring-track");
    const fill = svg("circle", "th-usage__ring-fill");

    for (const circle of [track, fill]) {
      circle.setAttribute("cx", "10");
      circle.setAttribute("cy", "10");
      circle.setAttribute("r", String(RING_R));
    }

    fill.setAttribute("stroke-dasharray", String(RING_C));
    fill.setAttribute("stroke-dashoffset", String(RING_C));

    ring.append(track, fill);
    return ring;
  }

  function limitRow(which, label) {
    const row = div("th-usage__limit");
    row.dataset.window = which;
    row.append(
      span("th-usage__limit-label", label),
      span("th-usage__limit-value", "—"),
      span("th-usage__limit-reset")
    );
    return row;
  }

  function createBar() {
    const bar = document.createElement("div");
    bar.className = "th-usage";
    /* Ring, then the percentage. Nothing else, ever — that invariant is the
       whole reason this fits on the composer's control row.

       There used to be a reset countdown here as well. It cost 40px at "3h
       0m" and 80px at "until 11:02 AM", which took the control from 63px to
       between 104 and 145 — and the row it lives on already holds the tool
       buttons, the mic and send. That is what put the toolbar in danger of
       breaking onto a second line, and the countdown was the only part of the
       control that varied in width at all. So the time moved to the two
       places that have room for it: the bar's own title on hover, and the
       popover on click. Nothing was lost from the product, only from the
       row. */
    const panel = div("th-usage__popover");
    panel.append(limitRow("session", "Current session"), limitRow("weekly", "Weekly"));

    bar.append(createRing(), span("th-usage__pct", "—"), panel);

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
    const ringEl = usageBar.querySelector(".th-usage__ring-fill");

    if (pctEl) pctEl.textContent = Math.round(session.pct) + "%";
    if (ringEl) {
      const shown = Math.max(0, Math.min(100, session.pct));
      /* A sliver stays drawn at 0% so the ring reads as empty rather than
         as broken — the same reason the old track kept 3px of fill there.
         With round caps that lands as a single dot at twelve o'clock. */
      const swept = Math.max(shown, 1.5) / 100;
      ringEl.setAttribute("stroke-dashoffset", String(RING_C * (1 - swept)));
      ringEl.toggleAttribute("data-warn", shown >= 90);
    }

    /* Turns the percentage coral — see usage.css. The only cue for spent that
       costs no width, which is the constraint the whole control is built
       around: at 100% the ring is already closed and already coral from the
       warn threshold, so without this a spent window and a 99% one look
       identical. */
    usageBar.toggleAttribute("data-spent", !!session.spent);

    /* The reset time, in the one place on a full toolbar row that is free:
       the native tooltip. The full sentence rather than the bare duration the
       old inline countdown used — a title has room, and "3h 0m" hanging in a
       tooltip on its own does not say what it is measuring. */
    if (session.spent) {
      const at = formatResetClock(session.resetsAt);
      usageBar.title = at
        ? "Session limit reached — you can use Claude again at " + at
        : "Session limit reached";
    } else {
      const reset = formatResetTime(session.resetsAt);
      usageBar.title = reset
        ? Math.round(session.pct) + "% of this session used · resets in " + reset
        : Math.round(session.pct) + "% of this session used";
    }

    updatePopover();
  }

  /* Where the gauge goes, in order of preference.

     Claude's composer is a single control row — [+] and the tool buttons on
     the left, dictation and send on the right — and the gauge belongs in
     that row, immediately left of the microphone. That puts it on one line
     with the controls it reports on rather than stacked under them, and it
     leaves the mic/send pair adjacent.

     The anchor is a cascade rather than one selector because this position
     has already moved once. It used to be a single query for
     [data-testid="model-selector-dropdown"]; when Claude moved the model
     picker out of the composer and down into the footer row beside "Claude
     is AI and can make mistakes", that query stopped resolving — and
     because the function returned rather than falling back, the bar was
     never inserted anywhere at all. A missing anchor should cost the
     preferred position, not the whole feature.

     So every step below degrades into the next, and the last is derived
     from the composer's own geometry and therefore cannot go missing. */

  const EDITABLE = 'textarea, [contenteditable="true"]';
  const DIALOG = '[role="dialog"], [aria-modal="true"], dialog';

  /* The dictation button, however Claude spells it this week. The exact
     testid is first, because when it is there it is unambiguous; the looser
     forms after it describe the same control more generally, so a rename
     inside Claude's own naming convention costs nothing.

     "mic" is anchored to the ends of the attribute rather than matched bare.
     A bare substring would also claim anything with "dynamic" in its
     testid, and the gauge would mount beside whatever that turned out to
     be. Every other form here carries a whole word that only the mic
     has. */
  const MIC = [
    '[data-testid="voice-input-button"]',
    '[data-testid*="dictation" i]',
    '[data-testid*="dictate" i]',
    '[data-testid*="voice-input" i]',
    '[data-testid*="microphone" i]',
    '[data-testid^="mic-" i]',
    '[data-testid$="-mic" i]',
    'button[aria-label*="dictate" i]',
    'button[aria-label*="dictation" i]',
    'button[aria-label*="microphone" i]',
    'button[aria-label*="voice mode" i]',
  ].join(",");

  /* Send, for the composer that has no mic — an older build, or a plan
     where dictation is not offered. It sits in the same right-hand cluster,
     so the gauge lands in the same row either way. */
  const SEND = [
    '[data-testid="send-button"]',
    '[data-testid*="send-button" i]',
    'button[aria-label*="send message" i]',
    'button[aria-label*="send" i]',
  ].join(",");

  /* The model picker, however Claude spells it this week. Below send now
     rather than above everything: it has spent the last few builds outside
     the composer entirely, and when it is inside it sits on the left, away
     from the controls the gauge reads with. */
  const MODEL_PICKER = [
    '[data-testid="model-selector-dropdown"]',
    '[data-testid*="model-selector" i]',
    '[data-testid*="model-picker" i]',
    '[data-testid*="model" i][aria-haspopup]',
    'button[aria-haspopup="menu"][data-testid*="model" i]',
  ].join(",");

  /* ---- the composer ---------------------------------------------------

     This used to come free. mark.js tagged Claude's card as
     [data-th-el="composer"] so base.css could paint it, and the gauge read
     the tag; both went with the theme. The tag was the only part worth
     keeping, so the one measurement that mattered is restated here.

     Not the whole of it, though. mark.js climbed to the element Claude
     *paints* as the card, because a fill has to land on exactly that
     element and nowhere near it. A gauge only has to be inserted into the
     row, so this climb stops at the first ancestor holding both the editor
     and a button of its own — which is the shape the slot cascade above
     searches, and no more. */

  const MIN_COMPOSER_WIDTH = 260;
  const MIN_EDITABLE_WIDTH = 120;

  /* The lowest wide text field on the page. Lowest, because Claude renders
     the composer beneath the transcript.

     Dialogs are fenced off rather than measured. Settings' General pane
     holds an "Instructions for Claude" textarea inside a card that also has
     buttons, which is exactly the shape the climb below hunts for — so with
     Settings open the gauge would mount into the settings panel. */
  function findEditable() {
    let best = null;
    let bestBottom = -Infinity;

    for (const el of document.querySelectorAll(EDITABLE)) {
      if (el.closest(DIALOG)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_EDITABLE_WIDTH) continue;
      if (rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        best = el;
      }
    }
    return best;
  }

  function findComposer() {
    const editable = findEditable();
    if (!editable) return null;

    let node = editable;
    for (let i = 0; i < 10 && node.parentElement; i += 1) {
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;

      /* A button that is not part of the editor. The editor can hold its
         own controls — the remove button on an inline attachment chip — and
         counting those would stop the climb inside it, below the row. */
      let hasToolbar = false;
      for (const button of node.querySelectorAll("button")) {
        if (!editable.contains(button) && !button.contains(editable)) {
          hasToolbar = true;
          break;
        }
      }
      if (!hasToolbar) continue;
      if (node.getBoundingClientRect().width < MIN_COMPOSER_WIDTH) continue;

      return node;
    }
    return null;
  }

  /* Re-measured only when the cached node has gone. Claude re-renders the
     composer subtree on every keystroke, and findComposer() walks every
     text field on the page — cheap once, wasteful at sixty frames a
     second. */
  let composerEl = null;

  function composer() {
    if (composerEl && composerEl.isConnected && composerEl.querySelector(EDITABLE)) {
      return composerEl;
    }
    composerEl = findComposer();
    return composerEl;
  }

  /* The composer's control strip. Identified by what it does rather than
     what it is called: the lowest band inside the composer that holds
     buttons, spans most of its width, and is not the editor.

     Height is capped because the composer itself would otherwise qualify —
     it holds buttons and spans its own width by definition.

     The parameter is `box` rather than `composer` on purpose: `composer` is
     the memoised lookup above, and a parameter of that name would shadow it
     inside this function. */
  const ROW_MAX_HEIGHT = 96;
  const ROW_MIN_WIDTH_RATIO = 0.6;

  function toolbarRow(box) {
    const editable = box.querySelector(EDITABLE);
    const boxWidth = box.getBoundingClientRect().width;
    if (boxWidth <= 0) return null;

    let best = null;
    let bestTop = -Infinity;

    for (const el of box.querySelectorAll("div, form, footer")) {
      /* The bar itself and its own popover are not candidate rows. Written as
         `el === usageBar || usageBar.contains(el)` rather than the other way
         round: disqualifying every element that *contains* the bar sounds
         equivalent but throws away the answer. Once the bar is mounted in the
         row, the row contains it — so the next pass would find no row at all,
         fall through to the composer, and re-parent the bar out of the row;
         the pass after that would find the row again and put it back. Every
         mutation flipped it, which is to say every keystroke. */
      if (usageBar && (el === usageBar || usageBar.contains(el))) continue;
      if (editable && (el === editable || el.contains(editable))) continue;
      if (!el.querySelector("button")) continue;

      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > ROW_MAX_HEIGHT) continue;
      if (rect.width < boxWidth * ROW_MIN_WIDTH_RATIO) continue;

      // The control strip sits below the text, so lowest wins.
      if (rect.top > bestTop) {
        bestTop = rect.top;
        best = el;
      }
    }
    return best;
  }

  /* The seam between the left-hand tools and the right-hand ones, which is
     where the gauge used to sit. Returns the first child that has crossed
     the row's midpoint, or null to mean "append". */
  function rightGroup(row) {
    const rect = row.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;

    for (const child of row.children) {
      if (child === usageBar) continue;
      const r = child.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.left + r.width / 2 >= mid) return child;
    }
    return null;
  }

  /* Anchored to a control rather than to a container. `before` is the node
     the gauge is inserted in front of, so the parent comes from that
     control's own parent — which puts the gauge in the same flex row as the
     rest of the toolbar rather than beside it.

     A control that is not laid out is not in the row. A hidden or
     not-yet-mounted button still answers querySelector, and inserting
     beside one would park the gauge somewhere invisible for the life of the
     page — so the box is measured before the slot is offered. */
  function controlSlot(box, selector) {
    const el = box.querySelector(selector);
    if (!el || !el.parentElement) return null;
    if (el === usageBar || el.contains(usageBar)) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return { parent: el.parentElement, before: el };
  }

  function rowSlot(box) {
    const row = toolbarRow(box);
    return row ? { parent: row, before: rightGroup(row) } : null;
  }

  function findSlot(box) {
    return (
      /* Left of the microphone — the asked-for position, and the one that
         keeps mic and send adjacent as a pair. */
      controlSlot(box, MIC) ||
      controlSlot(box, SEND) ||
      controlSlot(box, MODEL_PICKER) ||
      rowSlot(box) ||
      /* Nothing measurable yet — the first frame after a route change can
         land before layout. The composer is still the right home, so take it
         and let the next pass refine the position. */
      { parent: box, before: null }
    );
  }

  function positionBar() {
    if (!usageBar) return;

    const box = composer();
    if (!box) return;

    const slot = findSlot(box);
    if (!slot || !slot.parent) return;

    // Already exactly where it belongs.
    if (
      usageBar.parentElement === slot.parent &&
      usageBar.nextElementSibling === slot.before
    ) {
      return;
    }

    slot.parent.insertBefore(usageBar, slot.before);
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

  let queued = false;

  /* Same rAF-in-a-hidden-tab problem as tokens.js and mark.js: a background
     tab never runs the callback, so the gauge would not mount until the tab
     was first looked at. Racing a timer alongside it mounts the bar whether
     or not anything is painting. */
  function flush() {
    if (!queued) return;
    queued = false;
    try {
      positionBar();
    } catch (e) {
      /* A re-render can detach the node we measured mid-pass. Never let
         repositioning throw out of an observer callback. */
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
    setTimeout(flush, 50);
  }

  async function init() {
    const injected = await TH.injectBridgeOnce();
    if (!injected) return;

    /* One gauge per page. A bfcache restore or a history navigation can run
       this file a second time in the same document, and the second copy
       would build its own bar and mount it beside the first — two gauges,
       only one of them being updated. Any bar already in the document is
       from a previous run of this same code, so it is removed rather than
       adopted: its click handlers and closure state belong to a module
       instance we can no longer reach. */
    for (const stale of document.querySelectorAll(".th-usage")) {
      stale.remove();
    }

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
