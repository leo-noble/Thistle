(function () {
  "use strict";

  const EDITABLE = 'textarea, [contenteditable="true"]';
  const MIN_BOX_WIDTH = 260;

  /* Everything in this file exists to restyle the app shell — the composer, the
     top bar, the disclaimer strip, the scrim. A modal is not the shell, and
     tagging inside one goes badly in both directions.

     Settings is the case that broke. Its General pane holds an "Instructions
     for Claude" textarea inside a card that also has buttons, which is exactly
     the shape markComposer() hunts for, so the whole card was painted as a
     composer. Its header sits flush against the top of the viewport at chrome
     height, so markChrome() tagged it as the top bar — and that rule blacks out
     the tagged element's children too, which flooded a large part of the panel
     and left the hard edge partway down the Memory list.

     Claude's own token classes still restyle dialogs. They just do it without
     us mistaking a settings panel for the composer. */
  const DIALOG = '[role="dialog"], [aria-modal="true"], dialog';

  function inDialog(el) {
    return !!el.closest(DIALOG);
  }

  function findEditable() {
    let best = null;
    let bestBottom = -Infinity;

    for (const el of document.querySelectorAll(EDITABLE)) {
      if (inDialog(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120) continue;
      if (rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        best = el;
      }
    }
    return best;
  }

  /* Claude paints the composer card over the "You are out of free messages
     until 6:30 PM" band: the band is tucked in behind the card's bottom edge,
     so the card's rounded corners stay whole. Our fill was landing underneath
     it instead, and the band's own top-left corner was drawn straight across
     the card's bottom-left curve.

     It only became visible once the climb started reaching the real card —
     before, the tagged element sat inside the card and its bottom edge never
     came near the band.

     Raising it is a two-part problem. `z-index` is honoured on a flex or grid
     item with no positioning at all, which the card most likely is, but is
     ignored outright on a static block. Forcing `position: relative` would
     cover that case, except it would also overwrite an `absolute` or `fixed`
     card and move it. So the position is read first and only marked when it is
     genuinely static — CSS then has an exact hook and guesses nothing. */
  function markStacking(box) {
    let position = "static";
    try {
      position = getComputedStyle(box).position || "static";
    } catch (e) {
      return;
    }
    if (position === "static") {
      box.dataset.thStatic = "1";
    } else {
      delete box.dataset.thStatic;
    }
  }

  /* Which element Claude actually draws as the composer card.

     Three structural guesses failed here, each for the same reason: they
     reasoned about how Claude nests things, and that nesting is not what I
     assumed. Single-child wrappers stopped too low and the box came out
     smaller than the original. Matching on text, then on "no other visible
     children", both stepped one level too high and swallowed the Write / Learn
     / Code chips.

     Claude's card is rounded. The wrapper that holds the card and the chips is
     not, and neither is the row the chips sit in — only the card and the chips
     themselves are, and a chip is far too narrow to pass the width gate. So the
     outermost wide, rounded ancestor is the card, with no assumption about
     depth or sibling order.

     The growth cap stops a rounded outer container, if one exists, from
     winning. It is deliberately tighter than the one the structural climb
     uses: a wrapper that merely pads the card adds an inset of a few px, while
     one that also holds the chips row or the blocked-message band adds the
     whole height of that band — 44px at the very least, and usually more. */
  const CARD_MIN_RADIUS = 8;
  const CARD_GROWTH_MAX = 24;

  function findPaintedCard(editable) {
    let node = editable;
    let best = null;

    for (let i = 0; i < 10 && node.parentElement; i += 1) {
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
      if (node.tagName === "MAIN") break;

      const rect = node.getBoundingClientRect();
      if (rect.width < MIN_BOX_WIDTH) continue;

      let radius = 0;
      try {
        radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
      } catch (e) {
        break;
      }
      if (radius < CARD_MIN_RADIUS) continue;

      if (best) {
        const b = best.getBoundingClientRect();
        if (
          rect.width - b.width > CARD_GROWTH_MAX ||
          rect.height - b.height > CARD_GROWTH_MAX
        ) {
          break; // this one holds the card *and* something else
        }
      }
      best = node;
    }
    return best;
  }

  /* The climb from the text field up to the card Claude actually draws.

     Stopping at single-child wrappers was the bug behind every "the box is
     smaller than the original" round. Claude's card holds more than one child,
     so the climb halted inside it and we painted an inner element — the card's
     own padding then sat *outside* our fill, and the box read as too small no
     matter how much padding was added back. Adding padding could never fix it;
     it only pushed the contents around within the wrong element.

     The test is what else a wrapper holds. An element that merely wraps the
     composer has nothing else visible inside it. The moment a parent has a
     second rendered child it is grouping the card with something else — the
     suggestion chips under the home composer, or the "You're out of free
     messages until 6:30 PM" band — and the card is where the climb stops.

     An earlier version compared text instead, on the theory that a pure
     wrapper adds no words. It did not hold on the home screen: the climb went
     one level past the card and the chips ended up painted inside the box.

     The size cap is the backstop for a parent that adds no text but is a
     full-height layout container — a padding wrapper adds an inset, not a
     region. */
  const WRAP_GROWTH_MAX = 96;

  function isCardWrapper(parent, box) {
    if (parent.tagName === "MAIN" || parent.tagName === "FORM") return false;

    /* Nothing else visible in it. A wrapper that only wraps the composer holds
       the composer and nothing more; the moment a parent has a second child
       that actually renders, it is grouping the card with something else and
       the card is where we stop.

       This is the check that matters, and the two things it protects are the
       reason: the suggestion chips under the home composer, and the "You're out
       of free messages until 6:30 PM" band. Both are siblings of the card, so
       both end the climb.

       Zero-size siblings are ignored on purpose — Claude leaves a lot of empty
       measurement and portal nodes lying around, and counting them would pin
       the climb one level too low. */
    for (const sib of parent.children) {
      if (sib === box) continue;
      const r = sib.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return false;
    }

    const p = parent.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // Pre-layout: fall back to a plain single-child test rather than guess.
    if (b.width <= 0 || b.height <= 0) return parent.children.length === 1;

    /* A pass-through wrapper adds an inset at most. Anything that adds a region
       is a layout container that happens to be empty right now. */
    return (
      p.width - b.width <= WRAP_GROWTH_MAX &&
      p.height - b.height <= WRAP_GROWTH_MAX
    );
  }

  /* Claude's rounded card is not always the element we end up tagging — it
     can sit a wrapper or two below it, and the wrapper itself is square.
     Dropping our own border-radius so the box would follow Claude's therefore
     left it with none at all, and the composer rendered as a hard rectangle.

     Read the radius off whichever element in the subtree spans the same width
     as the box — that is the card — and hand it to CSS as a variable. A radius
     occupies no layout, so this cannot change the box's size. */
  const RADIUS_SPAN = 0.8;

  function inheritRadius(box) {
    const width = box.getBoundingClientRect().width;
    if (width <= 0) return;

    let best = 0;
    for (const el of [box, ...box.querySelectorAll("div, form")]) {
      if (el.getBoundingClientRect().width < width * RADIUS_SPAN) continue;
      const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      if (r > best) best = r;
    }

    if (best > 0) box.style.setProperty("--th-composer-radius", best + "px");
  }

  function markComposer() {
    const current = document.querySelector('[data-th-el="composer"]');
    const editable = findEditable();

    if (!editable) {
      if (current) current.removeAttribute("data-th-el");
      return;
    }

    if (current && current.isConnected && current.contains(editable)) {
      /* Re-measure only until it takes. The first frame after a navigation can
         land before layout settles, and a card measured at zero width would
         otherwise stay square for the life of the page. */
      if (!current.style.getPropertyValue("--th-composer-radius")) {
        inheritRadius(current);
        markStacking(current);
      }
      return;
    }

    let box = null;
    let node = editable;

    for (let i = 0; i < 10 && node.parentElement; i += 1) {
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;

      const buttons = node.querySelectorAll("button");
      let hasToolbar = false;
      for (const button of buttons) {
        if (!editable.contains(button) && !button.contains(editable)) {
          hasToolbar = true;
          break;
        }
      }
      if (!hasToolbar) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < MIN_BOX_WIDTH) continue;

      box = node;
      break;
    }

    if (!box) {
      if (current) current.removeAttribute("data-th-el");
      return;
    }

    /* Prefer the element Claude paints as the card. The structural climb below
       is the fallback for layouts with no rounded ancestor at all — a flat
       composer, or a build where the radius comes from something we cannot
       read. Anchoring to the paint is what keeps the chips outside the box. */
    const card = findPaintedCard(editable);
    if (card && card.contains(editable)) {
      box = card;
    } else {
      while (
        box.parentElement &&
        box.parentElement !== document.body &&
        isCardWrapper(box.parentElement, box)
      ) {
        box = box.parentElement;
      }
    }

    if (current && current !== box) current.removeAttribute("data-th-el");
    box.dataset.thEl = "composer";
    inheritRadius(box);
    markStacking(box);
  }

  /* Claude's top bar and the "can make mistakes" footer both read as a
     raised grey band. Neither ships a testid and their classes hash.

     Two earlier attempts failed for the same reason — each gated on one
     property that turned out not to hold. position:sticky/fixed matched
     nothing (both render in normal flow inside a flex column), and then
     a background-colour test matched nothing either, because the grey
     is not painted by a fill at all: it comes from backdrop-filter
     blurring the content behind a transparent element. Gate on either
     signal, and treat the blur as sufficient on its own. */
  const DISCLAIMER = /can make mistakes|double-check/i;

  /* Perceived lightness of the element's own fill, or -1 when it has
     none. Alpha is folded in against the near-black canvas — a white
     fill at 6% is a faint veil, not a grey band. */
  function fillLightness(el, style) {
    const m = style.backgroundColor.match(
      /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/
    );
    if (!m) return -1;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.02) return -1;
    return ((+m[1] + +m[2] + +m[3]) / 3) * alpha;
  }

  function hasBlur(style) {
    const filter = style.backdropFilter || style.webkitBackdropFilter || "none";
    return filter !== "none" && filter.includes("blur");
  }

  // Anything lighter than this reads as a grey band on a #000 canvas.
  const GREY_FLOOR = 8;

  function isGreyChrome(el) {
    const style = getComputedStyle(el);
    // A blur over dark content greys it out regardless of any fill.
    return hasBlur(style) || fillLightness(el, style) >= GREY_FLOOR;
  }

  /* Conversation content, as opposed to chrome. Message bubbles scroll
     through the top strip of the viewport, and an earlier version tagged
     whichever one happened to be sitting there as the top bar — which
     then flattened it to the canvas and made the user's own prompts
     indistinguishable from the background. Chrome never lives inside the
     transcript, so anything that does is off limits. */
  const CONTENT = '[data-testid="user-message"], [class*="font-claude" i]';

  function isTranscriptContent(el) {
    if (el.matches(CONTENT) || el.closest(CONTENT)) return true;
    // A wrapper that holds messages is content too, not a chrome bar.
    return !!el.querySelector(CONTENT);
  }

  function markChrome() {
    const composer = document.querySelector('[data-th-el="composer"]');
    const vw = window.innerWidth;
    const haveTopbar = !!document.querySelector('[data-th-el="topbar"]');

    for (const el of document.querySelectorAll("body *")) {
      if (el.dataset.thEl) continue;
      // The composer keeps its own fill, as does anything inside it.
      if (composer && (el === composer || el.contains(composer) || composer.contains(el))) continue;
      if (isTranscriptContent(el)) continue;
      if (inDialog(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > 120) continue;

      const text = (el.textContent || "").trim();
      /* Chrome is pinned, so it sits flush against the viewport top —
         a scrolling bubble only ever grazes that band. Requiring near-zero
         top, plus a single topbar per page, keeps content out. */
      const isTop = !haveTopbar && rect.top <= 8;
      const isFooter = DISCLAIMER.test(text) && text.length < 200;
      if (!isTop && !isFooter) continue;

      /* The top bar spans the content column beside the sidebar, so it
         is measured against the space right of the rail rather than the
         whole viewport — with the sidebar open it is barely over half. */
      if (rect.width < (vw - rect.left) * 0.5) continue;
      if (!isGreyChrome(el)) continue;

      el.dataset.thEl = isTop ? "topbar" : "disclaimer";
      if (isTop) return; // one top bar is enough
    }
  }

  /* Claude nests each user message in wrappers that carry their own fill.
     Once the testid element is styled as the bubble, the nearest filled
     wrapper reads as a second box drawn around it.

     Three CSS attempts failed. `:has(> …)` and `:has(> * > …)` each pinned
     a fixed depth and guessed wrong, and a descendant `:has()` flattened
     so much of the column that it could not be trusted. Walking up from
     the message in JS removes the guess entirely: tag each ancestor until
     one turns out to be shared, then let CSS flatten exactly those. */
  const USER_MSG = '[data-testid="user-message"]';
  const ASSISTANT = '[class*="font-claude" i]';
  const MAX_WRAP_DEPTH = 6;

  function markUserMessages() {
    for (const msg of document.querySelectorAll(USER_MSG)) {
      let node = msg.parentElement;

      for (let i = 0; i < MAX_WRAP_DEPTH && node; i += 1) {
        if (node === document.body || node === document.documentElement) break;
        if (node.tagName === "MAIN") break;

        /* Stop at the transcript. A per-message wrapper holds exactly one
           message and no reply; anything broader is shared scaffolding and
           has to keep whatever fill it was given. */
        if (node.querySelectorAll(USER_MSG).length > 1) break;
        if (node.querySelector(ASSISTANT)) break;

        node.dataset.thEl = "usermsg-wrap";
        node = node.parentElement;
      }
    }
  }

  /* The scroll scrim: a band sitting directly above the composer that fades
     the transcript out behind it, and parks transient controls ("Quick
     answer", scroll-to-bottom) inside itself.

     markChrome() cannot see this one. Its gates are a fill light enough to
     read as grey, or a backdrop blur — and the scrim is neither. The grey
     comes from a gradient stop, so backgroundColor is transparent and
     fillLightness() returns -1. Detect the gradient itself instead, and gate
     on sitting against the composer so ordinary gradients elsewhere on the
     page (the send button, avatars) are left alone. */
  function hasGradient(style) {
    const image = style.backgroundImage || "none";
    return image !== "none" && image.includes("gradient");
  }

  function hasFade(style) {
    const mask =
      style.maskImage || style.webkitMaskImage || "none";
    return mask !== "none" && mask.includes("gradient");
  }

  function markScrim() {
    const composer = document.querySelector('[data-th-el="composer"]');
    if (!composer) return;

    const box = composer.getBoundingClientRect();
    if (box.width <= 0) return;

    for (const el of document.querySelectorAll("body *")) {
      if (el.dataset.thEl) continue;
      if (el === composer || el.contains(composer) || composer.contains(el)) continue;
      if (isTranscriptContent(el)) continue;
      if (inDialog(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > 220) continue;

      /* Anchored to the composer: the band's foot lands at or just past the
         composer's head. A transcript bubble drifting through the same strip
         of viewport fails this the moment it scrolls. */
      const sitsAbove =
        rect.bottom <= box.top + 24 && rect.bottom >= box.top - 200;
      if (!sitsAbove) continue;

      // Spans the column, rather than being a button floating in it.
      if (rect.width < box.width * 0.6) continue;

      const style = getComputedStyle(el);
      if (!hasGradient(style) && !hasFade(style) && !hasBlur(style)) continue;

      el.dataset.thEl = "scrim";
    }
  }

  function run() {
    try {
      markComposer();
      markUserMessages();
      markChrome();
      markScrim();
    } catch (e) {
      /* never let tagging break the page */
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      run();
    });
  }

  function start() {
    run();
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
