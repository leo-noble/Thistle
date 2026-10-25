/* ============================================================
   Thistle — usage.js
   Inline session-usage gauge in the composer's control row, sitting
   immediately left of the dictation button. A small ring in an
   icon-button square, like Claude Code's; the percentage and reset
   time are in its title, and a click opens the session and weekly
   breakdown.

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

  /* A reset already in the past is no reset at all — the window has rolled
     over and the next one opens with the next message — so it formats as
     nothing rather than the "0m" that used to sit there indefinitely.
     Past a day the weekly window reads in days; "95h 12m" was accurate and
     unreadable. */
  function formatResetTime(resetAt) {
    if (!resetAt) return "";
    const diffMs = new Date(resetAt).getTime() - Date.now();
    if (!(diffMs > 0)) return "";
    const totalMin = Math.max(1, Math.round(diffMs / 60000));
    if (totalMin < 60) return totalMin + "m";
    const totalH = Math.floor(totalMin / 60);
    if (totalH >= 24) return Math.floor(totalH / 24) + "d " + (totalH % 24) + "h";
    return totalH + "h " + (totalMin % 60) + "m";
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
    const kept = prev.resetsAt && new Date(prev.resetsAt).getTime() > Date.now() ? prev.resetsAt : null;
    return { pct: next.pct, resetsAt: kept, spent: next.spent };
  }

  /* What a window with no reading looks like. The usage endpoint answers
     `five_hour: null` until the first message of a window is sent — every
     fresh session, and every free-plan account at rest — and the gauge used
     to treat that as "no answer yet" and sit on an em dash forever. It is
     an answer: nothing used. */
  const EMPTY = { pct: 0, resetsAt: null, spent: false };

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
     and the clamp below pushed the panel left of where it belonged.

     The gap is a menu's, not a tooltip's: with no caret to bridge it, the
     panel sits as close to the gauge as Claude's own menus sit to theirs. */
  const POP_GAP = 8;
  const POP_EDGE = 16;

  function positionPopover(bar, popover) {
    const rect = bar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    /* Measured, so the panel has to be showing by the time this runs — which
       is why openPopover() promotes it before it positions it rather than
       after. The fallback is only for the frame where layout has not caught
       up with a just-opened panel. */
    const width = popover.getBoundingClientRect().width || 280;

    let left = rect.left;
    if (left + width > vw - POP_EDGE) left = vw - width - POP_EDGE;
    if (left < POP_EDGE) left = POP_EDGE;

    /* Above the bar by default. If the bar sits high enough that the panel
       would run off the top — a short mobile viewport with the keyboard up —
       flip it below, growing downward from the gauge instead. */
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

    /* No caret — Claude's own menus don't draw one, and the panel reads as
       one of them. The open animation grows out of the gauge instead, so
       the origin is the bar's centre in panel-local coordinates. */
    const origin = Math.max(0, Math.min(width, rect.left + rect.width / 2 - left));
    popover.style.setProperty("--th-origin-x", origin + "px");
  }

  /* ---- keeping the panel on the gauge ---------------------------------

     The panel is promoted into the top layer for as long as it is open.

     Not decoration. `position: fixed` resolves against the nearest ancestor
     carrying a transform, filter or containment — not against the viewport —
     and Claude's page shell animates a transform on the wrapper it slides
     when the sidebar opens. With the panel sitting inside the composer, that
     wrapper became its containing block the moment the sidebar moved, so the
     left and bottom computed from the bar's viewport rect were suddenly being
     resolved against a box that had itself been displaced. The panel was
     carried off to the side of the gauge it is meant to be pointing at, and
     no amount of arithmetic here could have corrected for it: the offset
     depends on a transform the page owns and does not announce.

     An element in the top layer has no such ancestor. Its containing block is
     the viewport whatever the page does to its own layout, it is outside the
     composer's overflow clipping, and it is above every stacking context on
     the page — which the z-index in usage.css was only ever guessing at. The
     attribute is `manual` rather than `auto` on purpose: light dismissal
     would close the panel on the first outside pointerdown, ahead of the
     handlers below that already implement outside-click and Escape, and the
     two together would fight over the composer's own click swallowing. */
  const TOP_LAYER = typeof HTMLElement.prototype.showPopover === "function";

  /* Re-anchored every frame the bar moves, for as long as the panel is open.

     Opening Claude's sidebar is a layout change rather than a scroll: the
     conversation column re-flows and the composer travels with it, over an
     animation rather than in one step. A position computed once at open time
     is wrong for every frame of that — which is the other half of why the
     panel ended up stranded beside a gauge that had moved out from under it.

     Reading the bar's rect per frame costs one measurement of a box the page
     is already laying out, and only while the panel is open, so it is free at
     rest. The virtue of doing it this way is that nothing has to be
     enumerated: the sidebar, a window resize, a scrolled transcript, a
     toolbar that grows a button and reflows the row are all just the bar
     having moved. */
  let trackFrame = 0;
  let trackedAt = "";

  function untrack() {
    if (trackFrame) cancelAnimationFrame(trackFrame);
    trackFrame = 0;
    trackedAt = "";
  }

  function track(bar, popover) {
    untrack();

    const step = () => {
      if (!popover.hasAttribute("data-open")) {
        trackFrame = 0;
        return;
      }
      trackFrame = requestAnimationFrame(step);

      // The composer can be rebuilt under an open panel; follow it out.
      if (!bar.isConnected) {
        closePopover(popover);
        return;
      }

      const r = bar.getBoundingClientRect();
      const at = [r.left, r.top, r.width, window.innerWidth, window.innerHeight].join();
      if (at === trackedAt) return;
      trackedAt = at;
      positionPopover(bar, popover);
    };

    trackFrame = requestAnimationFrame(step);
  }

  function openPopover(bar, popover) {
    if (popover.hasAttribute("data-open")) return;

    if (TOP_LAYER) {
      try {
        popover.showPopover();
      } catch (e) {
        /* Already showing, or detached between the click and here. The
           attribute path below still yields a usable panel either way. */
      }
    } else if (popover.parentElement !== document.body) {
      /* No top layer to escape into, so at least leave the subtree whose
         ancestors are the ones that move. */
      document.body.append(popover);
    }

    /* Shown first, positioned second, both inside this one task — so the
       measurement above sees a laid-out panel and the browser still paints
       only once, at the right place. Positioning first would measure a
       display:none box and flash the panel wherever the previous open left
       it. */
    popover.setAttribute("data-open", "");
    bar.setAttribute("aria-expanded", "true");
    /* The native tooltip would otherwise hang over the panel that already
       says everything it does. Restored on close. */
    bar.dataset.title = bar.title;
    bar.removeAttribute("title");
    positionPopover(bar, popover);
    track(bar, popover);
  }

  function closePopover(popover) {
    if (!popover.hasAttribute("data-open")) return;
    popover.removeAttribute("data-open");
    untrack();

    const bar = popover.closest(".th-usage") || usageBar;
    if (bar) {
      bar.setAttribute("aria-expanded", "false");
      if (bar.dataset.title) bar.title = bar.dataset.title;
      delete bar.dataset.title;
    }

    if (TOP_LAYER) {
      try {
        popover.hidePopover();
      } catch (e) {
        /* Not showing. Nothing to undo. */
      }
    }
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

  /* One window: label and figure on a line, a hairline meter under them,
     the reset under that — the shape of Claude's own Settings › Usage
     page, at menu scale. */
  function limitRow(which, label) {
    const row = div("th-usage__limit");
    row.dataset.window = which;

    const top = div("th-usage__limit-top");
    top.append(span("th-usage__limit-label", label), span("th-usage__limit-value", "—"));

    const meter = div("th-usage__meter");
    meter.append(span("th-usage__meter-fill"));

    row.append(top, meter, span("th-usage__limit-reset"));
    return row;
  }

  const USAGE_PAGE = "/settings/usage";

  function createBar() {
    const bar = document.createElement("div");
    bar.className = "th-usage";
    /* Ring, then the percentage — and the percentage is visually hidden
       (usage.css), so what the row shows is one icon-button square, like
       Claude Code's. Nothing else, ever: that invariant is the whole reason
       this fits on the composer's control row.

       The reset countdown and, later, the visible digits both moved to the
       places that have room for them: the bar's own title on hover, and the
       popover on click. Nothing was lost from the product, only from the
       row. */
    const panel = div("th-usage__popover");
    if (TOP_LAYER) panel.setAttribute("popover", "manual");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Usage");

    const head = div("th-usage__head");
    const link = document.createElement("a");
    link.className = "th-usage__link";
    link.href = USAGE_PAGE;
    link.textContent = "Details";
    head.append(span("th-usage__title", "Usage"), link);

    panel.append(head, limitRow("session", "Current session"), limitRow("weekly", "Weekly"));

    /* Keyboard-reachable, which a bare div was not: it takes focus in the
       toolbar's tab order and Enter/Space open it, like the buttons either
       side of it. role=button rather than a <button> element because the
       panel — with a link in it — lives inside, and interactive content
       inside a <button> is invalid. */
    bar.setAttribute("role", "button");
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-haspopup", "dialog");
    bar.setAttribute("aria-expanded", "false");
    bar.setAttribute("aria-label", "Session usage");

    bar.append(createRing(), span("th-usage__pct", "—"), panel);

    const popover = bar.querySelector(".th-usage__popover");

    bar.addEventListener("keydown", (e) => {
      if (e.target !== bar || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      if (popover.hasAttribute("data-open")) closePopover(popover);
      else openPopover(bar, popover);
    });

    /* The composer swallows stray clicks to focus the editor, so the toggle
       and the popover's own clicks both stop propagation — otherwise opening
       the popup would immediately blur it or land the caret in the prompt.

       The panel stays a DOM child of the bar even while it is rendering in
       the top layer, so its clicks still arrive here and this guard is still
       the thing that keeps them from re-toggling the panel shut. */
    bar.addEventListener("click", (e) => {
      if (popover.contains(e.target)) return;
      e.stopPropagation();

      if (popover.hasAttribute("data-open")) closePopover(popover);
      else openPopover(bar, popover);
    });

    popover.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", () => {
      closePopover(popover);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopover(popover);
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
      const fillEl = el.querySelector(".th-usage__meter-fill");

      /* A window the account does not have — the weekly one on plans
         without it — is left out rather than shown as an empty row. The
         session row always stays: it is the one the gauge itself reads. */
      el.hidden = !row.data && row.key !== "session";

      if (!row.data) {
        if (valueEl) valueEl.textContent = "—";
        if (resetEl) resetEl.textContent = "";
        if (fillEl) fillEl.style.setProperty("--th-p", "0%");
        el.removeAttribute("data-warn");
        el.removeAttribute("data-caution");
        el.removeAttribute("data-spent");
        continue;
      }

      const pct = Math.max(0, Math.min(100, row.data.pct));
      if (valueEl) valueEl.textContent = Math.round(pct) + "%";
      if (fillEl) fillEl.style.setProperty("--th-p", pct + "%");
      el.toggleAttribute("data-warn", pct >= WARN_AT);
      el.toggleAttribute("data-caution", pct >= CAUTION_AT && pct < WARN_AT);
      el.toggleAttribute("data-spent", !!row.data.spent);

      if (resetEl) {
        /* Three cases, in order of how much is known. Spent gets the wall
           clock, which is what claude.ai's own blocked notice quotes.
           Otherwise a duration.

           With nothing used the API returns no resets_at — the window
           hasn't opened yet. Blank there reads as a missing value, so say
           what's actually true instead. */
        if (row.data.spent) {
          const at = formatResetClock(row.data.resetsAt);
          resetEl.textContent = at ? "Limit reached · back at " + at : "Limit reached";
        } else {
          const reset = formatResetTime(row.data.resetsAt);
          resetEl.textContent = reset ? "Resets in " + reset : "Starts with your next message";
        }
      }
    }
  }

  /* Where the ring turns from Claude's clay to the warning red. */
  /* Three stages, as Claude Code's own ring has: the accent blue, the
     warning yellow from three-quarters spent, the danger red from 90%. */
  const CAUTION_AT = 75;
  const WARN_AT = 90;

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
      ringEl.toggleAttribute("data-warn", shown >= WARN_AT);
      ringEl.toggleAttribute("data-caution", shown >= CAUTION_AT && shown < WARN_AT);
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
    let title;
    if (session.spent) {
      const at = formatResetClock(session.resetsAt);
      title = at
        ? "Session limit reached — you can use Claude again at " + at
        : "Session limit reached";
    } else {
      const reset = formatResetTime(session.resetsAt);
      title = reset
        ? Math.round(session.pct) + "% of this session used · resets in " + reset
        : Math.round(session.pct) + "% of this session used";
    }

    /* While the panel is open the tooltip is parked (see openPopover), so a
       reading that lands then updates the parked copy rather than bringing
       the tooltip back over the panel. */
    if (usageBar.getAttribute("aria-expanded") === "true") usageBar.dataset.title = title;
    else usageBar.title = title;
    usageBar.setAttribute("aria-label", title);

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
    "#composer-dictate",
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
    '[data-testid="chat-input-send"]',
    '[data-testid="send-button"]',
    '[data-testid*="send-button" i]',
    'button[aria-label*="send message" i]',
    'button[aria-label*="send" i]',
  ].join(",");

  /* The stop button, which is what send becomes while a response streams.

     This rung is the fix for the gauge jumping to the middle of the composer
     on submit. Claude does not merely relabel send: it swaps the control, and
     it does not keep the dictation button mounted through every frame of the
     handover either. So for the duration of a generation — not a frame, the
     whole of it — MIC and SEND both failed to resolve, MODEL_PICKER has lived
     outside the composer for several builds now, and the cascade fell all the
     way through to the row. The row's seam anchor then placed the gauge at the
     row's geometric midpoint, which is the middle of the composer, and put it
     back beside the mic when the response finished. Twice a prompt.

     Anchoring on stop is also what the control should do on its own terms: the
     gauge reads on the session the response is spending, so the two belong
     next to each other. aria-label is anchored at the start rather than
     matched bare — "Stop" and "Stop response" both want catching, but a bare
     substring inside the composer would also claim a "Stop dictation" that
     sits elsewhere in the row. */
  const STOP = [
    '[data-testid="stop-button"]',
    '[data-testid*="stop-button" i]',
    '[data-testid*="stop-response" i]',
    '[data-testid*="stop-generat" i]',
    'button[aria-label^="stop response" i]',
    'button[aria-label^="stop generating" i]',
    'button[aria-label^="stop streaming" i]',
    'button[aria-label="Stop" i]',
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

  /* A page with no composer — settings, a project list, the artifacts
     gallery — has none to find, and finding it means measuring every text
     field on the page. That used to repeat on every change; now it is tried
     at most every SCAN_MS (a composer mounts in a moment, not a frame) and
     the pass is re-armed for when the window closes. */
  const SCAN_MS = 500;
  /* -Infinity, not 0: performance.now() counts from navigation start, so on a
     fresh load 0 would read as "just scanned" and postpone the first look. */
  let lastScan = -Infinity;

  function composer() {
    if (composerEl && composerEl.isConnected && composerEl.querySelector(EDITABLE)) {
      return composerEl;
    }
    const now = performance.now();
    if (now - lastScan < SCAN_MS) {
      later();
      return null;
    }
    lastScan = now;
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

  /* The seam between the left-hand tools and the right-hand cluster — where
     the gauge goes when no individual control could be identified.

     Found from the widest horizontal gap between consecutive controls, not by
     cutting the row at its midpoint. The midpoint was the second half of the
     jump-to-the-middle bug. Claude's row is [tools] … [mic][send] with the two
     groups pushed apart by a spacer or a margin, and the first child whose
     centre clears the halfway mark is usually that spacer — so the gauge was
     inserted at the row's geometric centre, adrift between the two groups and
     further adrift the wider the window got. Anchoring to the gap instead asks
     the layout where it thinks the groups divide, which is a question that has
     the same answer at every width.

     A gap has to be worth calling a seam. Below the threshold the row is one
     contiguous run of controls with no left/right split to find, so the
     right-hand end of it is simply the end — null, meaning append. */
  const SEAM_MIN_GAP = 16;

  function rightGroup(row) {
    const kids = [];
    for (const child of row.children) {
      if (child === usageBar) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      kids.push({ el: child, rect });
    }
    if (!kids.length) return null;

    // DOM order need not be visual order once a flex row starts reordering.
    kids.sort((a, b) => a.rect.left - b.rect.left);

    let seam = null;
    let widest = SEAM_MIN_GAP;
    for (let i = 1; i < kids.length; i += 1) {
      const gap = kids[i].rect.left - kids[i - 1].rect.right;
      if (gap >= widest) {
        widest = gap;
        seam = kids[i].el;
      }
    }

    return seam;
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

    const root = clusterRoot(el, box);
    if (!root || !root.parentElement || root.contains(usageBar)) return null;
    return { parent: root.parentElement, before: root };
  }

  /* ---- the control's own footprint --------------------------------------

     A control is no longer a direct child of the row. In the current
     composer the dictation button sits five wrappers deep: two
     `display: contents` segments, a split button that pairs it with the
     microphone-picker chevron, and a stack of single-child cells in a grid
     that overlays it with whatever replaces it mid-generation. Inserting
     beside the button itself — what this used to do — put the gauge inside
     the split button's rounded outline, between its two halves, and, one
     level up, into a grid cell where it was laid over the mic.

     So the anchor is climbed to the outermost element that is still only
     this control: up through wrappers that hold nothing else laid out,
     through the split group, and no further than the first horizontal flex
     row in which it has a laid-out neighbour. That row is the toolbar, and
     the climbed element is what the gauge goes in front of. */
  const SPLIT = '[class*="group/split"], [role="group"]';

  function isRow(el) {
    const cs = getComputedStyle(el);
    return (cs.display === "flex" || cs.display === "inline-flex") &&
      !cs.flexDirection.startsWith("column");
  }

  function laidOutChildren(el) {
    let n = 0;
    for (const child of el.children) {
      if (child === usageBar) continue;
      const r = child.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) n += 1;
    }
    return n;
  }

  /* Returns the element to insert in front of, or null when there is no
     horizontal row to insert into at all.

     The climb can run out before it finds a neighbour. Claude Code's
     composer has the mic alone on the right — no send, no split, no voice
     mode beside it — so every wrapper up to the card holds a single laid-out
     child and the neighbour test never fires. Returning whatever the climb
     ended on then meant inserting into the card itself, in plain block flow:
     the gauge dropped to the card's start edge, under the absolutely
     positioned [+] button, ring printed over the plus.

     So the climb also remembers the outermost point where the parent was a
     horizontal flex row, and falls back to that. The gauge then lands at the
     start of the mic's own toolbar, which is the same "left of the mic" as
     everywhere else. A parent that is not a row is never offered. */
  function clusterRoot(el, box) {
    const editable = box.querySelector(EDITABLE);
    let node = el;
    let lastInRow = null;
    for (let i = 0; i < 12; i += 1) {
      const parent = node.parentElement;
      if (!parent || parent === box || (editable && parent.contains(editable))) break;

      const r = node.getBoundingClientRect();
      const laidOut = r.width > 0 && r.height > 0;
      const row = laidOut && !parent.matches(SPLIT) && isRow(parent);
      if (row && laidOutChildren(parent) >= 2) return node;
      if (row) lastInRow = node;
      node = parent;
    }
    if (lastInRow) return lastInRow;

    /* No flex row anywhere on the way up — a toolbar that is a plain block
       holding inline buttons. Beside the control in its own parent is still
       inline with it, so that is the answer, as long as the parent is a
       toolbar and not the card. */
    const own = el.parentElement;
    return own && !(editable && own.contains(editable)) && getComputedStyle(own).display !== "contents"
      ? el
      : null;
  }

  function rowSlot(box) {
    const row = toolbarRow(box);
    /* Only a horizontal row. A block container takes the gauge in plain flow
       at its start edge — under whatever is absolutely positioned there. */
    return row && isRow(row) ? { parent: row, before: rightGroup(row) } : null;
  }

  /* Rungs of the cascade, lowest is best. Named so positionBar() can tell an
     improvement from a downgrade, which is the whole of how the gauge is kept
     still while Claude rebuilds the controls around it. */
  /* ---- the footer corner ----------------------------------------------

     Where Claude Code on the web puts its own ring: the far end of the line
     under the composer, after the model picker — "Opus 5.5 High ◯". The
     chat composer carries the same line ("Sonnet 5.5 Medium  Auto"), so the
     gauge ends it the same way.

     It is also the steadiest place on the page. The composer's own control
     row is rebuilt on every keystroke and every submit — send swaps for
     stop, the mic unmounts — and where its controls sit differs between
     layouts (some put the mic and voice buttons down on this line instead).
     The model picker is on this line in all of them and does not move while
     a reply streams.

     The picker is found page-wide, because the line sits outside the
     composer card, but only one that is laid out on a line just below (or
     inside) the composer counts — not one in a settings panel or a menu. The
     row is the first horizontal flex row on the way up where the picker has
     a laid-out neighbour; the gauge is appended to it, so it is always the
     last thing on the line. */
  const FOOTER_REACH = 120;

  function footerRow(picker, editable) {
    let node = picker;
    for (let i = 0; i < 10; i += 1) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || (editable && parent.contains(editable))) return null;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && isRow(parent) && laidOutChildren(parent) >= 2) return parent;
      node = parent;
    }
    return null;
  }

  /* ---- the rest of the footer line -----------------------------------

     Claude Code's line reads "Default  Repo  Auto ·········· Opus 5.5 High ◯":
     tools and modes on the left, and on the right only the model, its effort
     and the ring. The chat line puts "Auto" in the right-hand cluster,
     between the picker and the gauge. So whatever shares the picker's
     cluster is carried over to the left side, after the line's own tools.

     Carried visually, never moved. These nodes are React's: if one is
     re-parented, React's next removeChild on its old parent throws and takes
     the page down with it. So the elements are only marked — attributes
     React does not render and so never clears — and usage.css does the
     moving: the wrappers between the cluster and the line, and the line's
     leading tool group, become `display: contents`, which makes all of their
     children items of the one line, and `order` sequences those items as
     tools, the carried controls, whatever stretches in the middle, the model,
     the ring.

     Every mark is recorded so it can all be undone the moment the gauge
     leaves the footer, and the whole arrangement is rebuilt if any marked
     node is replaced. */
  const FLAT = "data-th-flat";
  const ORDER = "data-th-order";
  let footerLayout = null;

  function laidOut(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function undoFooterLayout() {
    if (!footerLayout) return;
    for (const el of footerLayout.marked) {
      el.removeAttribute(FLAT);
      el.removeAttribute(ORDER);
    }
    footerLayout = null;
  }

  function footerLayoutIntact(row) {
    return (
      !!footerLayout &&
      footerLayout.row === row &&
      row.isConnected &&
      /* A control Claude adds to the cluster later has not been sequenced, and
         one it removes has left a mark behind; either way the arrangement is
         out of date. */
      row.children.length === footerLayout.kids &&
      footerLayout.marked.every((el) => el.isConnected)
    );
  }

  function applyFooterLayout(row, picker, editable) {
    if (footerLayoutIntact(row)) return;
    undoFooterLayout();
    footerLayout = { row, marked: [], kids: row.children.length };
    const mark = (el, attr, value) => {
      el.setAttribute(attr, value);
      footerLayout.marked.push(el);
    };

    const pickerItem = Array.from(row.children).find((c) => c.contains(picker));
    const carried = Array.from(row.children).filter(
      (c) => c !== usageBar && c !== pickerItem && laidOut(c)
    );
    if (!pickerItem || !carried.length) return;

    /* The line: the first horizontal row above the cluster that holds
       something besides the branch the cluster is on. */
    let branch = row;
    let line = row.parentElement;
    for (let i = 0; i < 6 && line; i += 1) {
      if (line === document.body || (editable && line.contains(editable))) return;
      if (isRow(line) && laidOutChildren(line) >= 2) break;
      branch = line;
      line = line.parentElement;
    }
    if (!line || !isRow(line)) return;

    const lead = Array.from(line.children).find((c) => c !== branch && laidOut(c));

    for (let n = row; n; n = n.parentElement) {
      mark(n, FLAT, "");
      if (n === branch) break;
    }
    for (const c of line.children) {
      if (c !== branch && c !== lead) mark(c, ORDER, "rest");
    }
    if (lead && isRow(lead)) {
      /* Opened up too, so the carried controls can sit among its tools
         rather than after its spacer — whatever in it stretches (the gap
         the disclaimer sits in) is sequenced after them. */
      mark(lead, FLAT, "");
      for (const c of lead.children) {
        mark(c, ORDER, parseFloat(getComputedStyle(c).flexGrow) > 0 ? "rest" : "lead");
      }
    } else if (lead) {
      mark(lead, ORDER, "lead");
    }
    for (const c of carried) mark(c, ORDER, "carried");
    mark(pickerItem, ORDER, "model");
  }

  /* Where to look for the picker: after the composer, never the whole page.
     This used to be document.querySelectorAll(MODEL_PICKER) — attribute-
     substring selectors, case-insensitive, walking every element on the page.
     On a long conversation that is tens of thousands of nodes, about 6 ms a
     time, and it ran on every DOM change whenever the gauge was not already
     settled on the footer: for as long as Claude streamed a reply, that is
     every frame, out of a budget of 16.

     The footer line comes after the composer in the document, so the search
     is the composer itself and then the siblings that follow it, a level at a
     time up the tree, nearest first. That finds the line however the
     containers around it are sized, and never reaches the transcript, which
     comes before. A sibling taller than the composer plus the reach below it
     is not a line under the composer and is skipped, which bounds the work on
     a layout this does not expect. */
  const CLIMB_MAX = 6;
  const SIBLINGS_MAX = 4;

  function nearbyPickers(box) {
    const limit = box.getBoundingClientRect().height + FOOTER_REACH + 40;
    const found = [];

    // A picker inside the card itself, where some layouts keep it.
    for (const p of box.querySelectorAll(MODEL_PICKER)) found.push(p);

    let node = box;
    for (let level = 0; level < CLIMB_MAX && node && node !== document.body; level += 1) {
      let sib = node.nextElementSibling;
      for (let n = 0; n < SIBLINGS_MAX && sib; n += 1, sib = sib.nextElementSibling) {
        if (sib.getBoundingClientRect().height > limit) continue;
        if (sib.matches(MODEL_PICKER)) found.push(sib);
        for (const p of sib.querySelectorAll(MODEL_PICKER)) found.push(p);
      }
      if (found.length) break;
      node = node.parentElement;
    }
    return found;
  }

  function footerSlot(box) {
    const editable = box.querySelector(EDITABLE);
    const card = box.getBoundingClientRect();

    /* Once the line is rearranged the cluster is display: contents and no
       longer measures as a row, so it is recognised by having been chosen,
       for as long as the picker is still in it. */
    if (footerLayout && footerLayoutIntact(footerLayout.row)) {
      const picker = footerLayout.row.querySelector(MODEL_PICKER);
      if (picker) return { parent: footerLayout.row, before: null, picker };
    }
    /* Broken — Claude replaced a node in it. The marks left on the rest
       would make the line measure as nothing, so they come off before the
       line is looked for again. */
    undoFooterLayout();

    for (const picker of nearbyPickers(box)) {
      if ((usageBar && usageBar.contains(picker)) || picker.closest(DIALOG)) continue;
      const r = picker.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.top < card.top || r.top > card.bottom + FOOTER_REACH) continue;
      if (r.right < card.left || r.left > card.right) continue;

      const row = footerRow(picker, editable);
      if (row) return { parent: row, before: null, picker };
    }
    return null;
  }

  const RANK = { footer: 0, mic: 1, stop: 2, send: 3, model: 4, row: 5 };

  function findSlot(box) {
    const at = (slot, rank) => (slot ? Object.assign(slot, { rank }) : null);

    return (
      at(footerSlot(box), RANK.footer) ||
      /* No footer line — left of the microphone, which keeps mic and send
         adjacent as a pair. When a response is streaming and both are present
         this is also immediately right of stop. */
      at(controlSlot(box, MIC), RANK.mic) ||
      at(controlSlot(box, STOP), RANK.stop) ||
      at(controlSlot(box, SEND), RANK.send) ||
      at(controlSlot(box, MODEL_PICKER), RANK.model) ||
      at(rowSlot(box), RANK.row) ||
      /* Nothing measurable yet — the first frame after a route change can
         land before layout. This used to fall back to appending into the
         composer card, which is block flow: the gauge drew at the card's
         start edge, over the absolutely positioned [+]. Not mounting is
         better than mounting there; the observer runs again on the next
         mutation, and layout has usually landed by then. */
      null
    );
  }

  /* The rung the gauge is currently mounted on, or Infinity when it is not
     mounted anywhere that counts. */
  let mountedRank = Infinity;

  /* Claude Code on the web draws its own usage ring in the corner of its
     composer, so a second one there is noise. It is a client-side route
     inside the same app — /new to /code and back without a page load — so
     this is checked on every pass rather than once at injection, and a
     manifest exclude_matches could not have done it. */
  function suppressed() {
    return /^\/code(\/|$)/.test(location.pathname);
  }

  /* ---- what a settled gauge costs ---------------------------------------

     positionBar() runs after every change to the page, and claude.ai changes
     constantly: every streamed token, every keystroke. A full pass walks the
     composer, reads layout, and may search; that is worth doing when
     something has actually moved, and wasted when nothing has.

     So a gauge that is exactly where the last pass put it — same parent, same
     neighbour, and for the footer the arrangement still whole — is left alone
     with a handful of property reads and no layout. Anything that stops being
     true falls straight through to the full pass, with no delay, so a
     re-render that removes the gauge is repaired on the next frame as before.

     Even a settled gauge is re-checked for real now and then, because a
     better position can appear without disturbing the one it is in (the
     footer line mounting after the composer, say): at most once per
     IDLE_MS, with a trailing re-check so a change inside the quiet window is
     never dropped. */
  const IDLE_MS = 400;
  /* Shorter for a gauge that has nowhere to go yet: a composer mounts in a
     moment, and the gauge should follow it promptly rather than after the
     quiet window — but still not on every change while it hasn't. */
  const SEEK_MS = 120;
  let foundLast = false;
  let mountedParent = null;
  let mountedBefore = null;
  let lastFull = -Infinity;
  let trailTimer = 0;

  function later(ms) {
    if (trailTimer) return;
    trailTimer = setTimeout(() => {
      trailTimer = 0;
      schedule();
    }, ms || IDLE_MS);
  }

  function atHome() {
    if (!usageBar.isConnected || mountedRank === Infinity) return false;
    if (usageBar.parentElement !== mountedParent || !mountedParent.isConnected) return false;
    if (usageBar.nextElementSibling !== mountedBefore) return false;
    if (mountedRank === RANK.footer) {
      return footerLayoutIntact(mountedParent) && mountedParent.lastElementChild === usageBar;
    }
    return !!composerEl && composerEl.isConnected && composerEl.contains(usageBar);
  }

  function positionBar() {
    if (!usageBar) return;

    if (suppressed()) {
      undoFooterLayout();
      if (usageBar.isConnected) {
        const panel = usageBar.querySelector(".th-usage__popover");
        if (panel) closePopover(panel);
        usageBar.remove();
      }
      mountedRank = Infinity;
      foundLast = false;
      return;
    }

    const now = performance.now();
    if (now - lastFull < IDLE_MS && atHome()) {
      later();
      return;
    }
    if (!foundLast && now - lastFull < SEEK_MS) {
      later(SEEK_MS);
      return;
    }
    lastFull = now;

    const box = composer();
    if (!box) return;

    /* Is the gauge still somewhere real? Detached, moved out of the composer,
       or sitting in a parent that has collapsed to nothing all mean the rung
       it was on has stopped existing, so the next slot found is an
       improvement by definition. */
    const parent = usageBar.parentElement;
    /* The footer line is outside the composer card, so a gauge there is home
       without the card containing it — but only while the picker it ends the
       line after is still in its cluster. The row can outlive the picker, and
       holding position in it would strand the gauge beside nothing. Its
       height is not asked: a rearranged cluster is display: contents and
       measures as nothing while laying out perfectly well. */
    const inFooter =
      mountedRank === RANK.footer && !!parent && !!parent.querySelector(MODEL_PICKER);
    const settled =
      usageBar.isConnected &&
      !!parent &&
      (inFooter || (box.contains(usageBar) && parent.getBoundingClientRect().height > 0));
    if (!settled) mountedRank = Infinity;

    const slot = findSlot(box);
    foundLast = !!slot && !!slot.parent;
    if (!foundLast) return;

    const footer = () => {
      if (mountedRank === RANK.footer && slot.picker) {
        applyFooterLayout(slot.parent, slot.picker, box.querySelector(EDITABLE));
      } else {
        undoFooterLayout();
      }
    };

    /* Hold position rather than accept a worse one.

       Claude rebuilds the right-hand cluster on every state change — submit
       swaps send for stop, generation can unmount the dictation button, and in
       between there are frames where none of them resolve at all. Moving on
       those frames is what made the gauge visibly jump: down to the row as the
       controls went, back up to the mic as they returned, on every prompt and
       again on every stop. A rung is given up only when the position it
       describes has actually stopped existing, which is what `settled`
       decides — so a control that merely blinks costs nothing, and one that is
       genuinely gone still degrades exactly as before. */
    if (settled && slot.rank > mountedRank) return;

    // Already exactly where it belongs.
    if (parent === slot.parent && usageBar.nextElementSibling === slot.before) {
      mountedRank = slot.rank;
      mountedParent = slot.parent;
      mountedBefore = slot.before;
      footer();
      return;
    }

    slot.parent.insertBefore(usageBar, slot.before);
    mountedRank = slot.rank;
    mountedParent = slot.parent;
    mountedBefore = slot.before;
    // usage.css spaces and orders the gauge on the footer line; see there.
    usageBar.toggleAttribute("data-footer", slot.rank === RANK.footer);
    footer();
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
      } else if (raw && typeof raw === "object" && "five_hour" in raw) {
        // Present and null: the window hasn't opened. See EMPTY.
        updateBar(exceeded ? { pct: 100, resetsAt: coerceReset(raw.resets_at), spent: true } : EMPTY);
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
      } else if (raw && typeof raw === "object" && "seven_day" in raw && snapshot.weekly) {
        /* Gone from the payload — the week rolled over, or the plan changed
           to one without it. Holding the old reading would show last week's
           figure until the page was reloaded. */
        snapshot.weekly = null;
        updatePopover();
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

  /* Coming back to the tab is when the reading matters most and is most
     likely stale: background tabs throttle the interval, and usage spent in
     another tab or on another device never reaches this one's stream. So
     the moment it is looked at again it asks, rather than showing up to
     thirty seconds of old number. Spaced so focus and visibilitychange
     arriving together cost one request, not two. */
  let lastWake = 0;

  function pollOnReturn() {
    if (document.visibilityState !== "visible" || !pollTimer) return;
    const now = Date.now();
    if (now - lastWake < 5000) return;
    lastWake = now;
    poll();
  }

  let queued = false;

  /* rAF alone is not enough: a background tab never runs the callback, so a
     Claude conversation opened in a new tab would have no gauge until the tab
     was first looked at. Racing a timer alongside it mounts the bar whether or
     not anything is painting. */
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
       instance we can no longer reach.

       Panels are swept separately as well as with their bars. On an engine
       without the Popover API openPopover() re-parents the panel to the body
       to get it out from under the composer's transformed ancestors, and a
       panel that has been through that is no longer inside the bar that owns
       it. */
    for (const stale of document.querySelectorAll(".th-usage, .th-usage__popover")) {
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

    /* Not for its own changes. Every reading rewrites the gauge's text, which
       is a mutation inside the subtree this watches, which scheduled a pass
       to look at a gauge that had not moved. */
    new MutationObserver((records) => {
      if (usageBar && records.every((r) => usageBar.contains(r.target))) return;
      schedule();
    }).observe(document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("visibilitychange", pollOnReturn);
    window.addEventListener("focus", pollOnReturn);

    schedule();
  }

  TH.usageSnapshot = () => snapshot;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
