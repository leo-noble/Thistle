/* Assertions for the usage-gauge fixture. Not shipped.

   Drives the real updateBar() through the same th:limit path claude.ai's SSE
   stream uses, so the ring geometry, the warn threshold, and the spent
   collapse are all exercised as shipped rather than reimplemented here.

   The anchor checks work the same way: rather than calling findSlot() — which
   is module-private and would be testing a function instead of a behaviour —
   they take a control out of the row and let usage.js's own MutationObserver
   reposition the gauge, then read where it ended up. */
(function () {
  "use strict";

  const R = 8;
  const C = 2 * Math.PI * R;

  function bar() {
    return document.querySelector(".th-usage");
  }
  function ring() {
    return document.querySelector(".th-usage__ring-fill");
  }
  function offset() {
    const el = ring();
    return el ? parseFloat(el.getAttribute("stroke-dashoffset")) : NaN;
  }

  /* utilization is 0-1 on the streamed path, resets_at Unix seconds. */
  function push(pct, opts) {
    const o = opts || {};
    globalThis.__emit("th:limit", {
      type: o.exceeded ? "exceeded_limit" : "message_limit",
      windows: {
        "5h": {
          utilization: pct / 100,
          resets_at: Math.floor(Date.now() / 1000) + 3 * 3600,
        },
        "7d": {
          utilization: 0.31,
          resets_at: Math.floor(Date.now() / 1000) + 4 * 86400,
        },
      },
    });
  }

  // Sweep fraction implied by the rendered dashoffset.
  function swept() {
    return (C - offset()) / C;
  }

  function near(a, b, tol) {
    return Math.abs(a - b) <= (tol === undefined ? 0.01 : tol);
  }

  /* Long enough for usage.js's schedule() to land: it races rAF against a
     50ms timer, and the mutation that triggers it is the one we just made. */
  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  const checks = [];
  function check(name, fn) {
    checks.push([name, fn]);
  }

  // ---- mounted at all, and in the right place
  check("gauge mounted", () => !!bar());
  check("only one gauge", () => document.querySelectorAll(".th-usage").length === 1);

  /* ---- the footer corner. Where Claude Code puts its ring, and the first
     choice whenever the model picker is on a line under the composer: the
     gauge is appended to that line, so it is the last thing on it. */
  const footer = () => document.querySelector(".footer");
  const picker = () => document.getElementById("picker");

  check("footer → ends the model picker's line", () => {
    return bar().parentElement === footer() && bar() === footer().lastElementChild;
  });
  check("footer → right of the picker, on its line", () => {
    const g = bar().getBoundingClientRect();
    const p = picker().getBoundingClientRect();
    return g.left >= p.right && Math.abs(g.top + g.height / 2 - (p.top + p.height / 2)) <= 1;
  });
  check("footer → marked for its spacing", () => bar().hasAttribute("data-footer"));
  check("footer → a whole prompt cycle never moves it", async () => {
    const home = bar().parentElement;
    const at = bar().getBoundingClientRect().left;
    for (const state of ["dictating", "submitting", "generating", "idle"]) {
      globalThis.__state(state);
      await settle();
      if (bar().parentElement !== home || Math.abs(bar().getBoundingClientRect().left - at) > 1) return false;
    }
    return true;
  });
  check("footer → panel opens from the corner and stays on screen", async () => {
    bar().click();
    await settle();
    const r = document.querySelector(".th-usage__popover").getBoundingClientRect();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth + 1;
  });

  /* Every check after this one is the fallback: a layout with no picker
     under the composer, where the gauge goes back beside the mic. Taking the
     picker away must move it — the footer row outliving its picker is not
     a reason to stay. */
  check("no picker → leaves the footer for the composer", async () => {
    picker().remove();
    for (let i = 0; i < 30 && !bar().closest(".card"); i += 1) await settle();
    return !!bar().closest(".card") && !bar().hasAttribute("data-footer");
  });
  /* The composer is found by geometry now, not by a tag mark.js left behind,
     so this asserts the climb stopped on Claude's card — not on the editor
     below it and not on <main> above it. */
  check("found the composer card", () => {
    const card = document.querySelector(".card");
    return !!card && card.contains(bar()) && !document.querySelector(".editor").contains(bar());
  });
  check("mounted in the composer's control row", () => {
    return !!bar().closest(".row");
  });
  check("sits immediately left of the mic", () => {
    const mic = document.getElementById("mic");
    return bar().nextElementSibling === mic && bar().parentElement === mic.parentElement;
  });
  check("left the mic and send adjacent", () => {
    return document.getElementById("mic").nextElementSibling === document.getElementById("send");
  });

  // ---- the ring is a real SVG, not an HTMLUnknownElement
  check("ring is an SVG element", () => {
    const el = document.querySelector(".th-usage__ring");
    return !!el && el.namespaceURI === "http://www.w3.org/2000/svg";
  });
  check("ring has a track and a fill", () => {
    return !!document.querySelector(".th-usage__ring-track") && !!ring();
  });
  check("dasharray pinned to the circumference", () => {
    return near(parseFloat(ring().getAttribute("stroke-dasharray")), C, 0.01);
  });
  check("ring renders at 16px", () => {
    const r = document.querySelector(".th-usage__ring").getBoundingClientRect();
    return Math.round(r.width) === 16 && Math.round(r.height) === 16;
  });
  // No --cds-* tokens in the fixture, so the accent's fallback blue.
  check("stroke is the accent blue", () => {
    return getComputedStyle(ring()).stroke === "rgb(37, 125, 224)";
  });
  check("sweep starts at twelve o'clock", () => {
    const t = getComputedStyle(document.querySelector(".th-usage__ring")).transform;
    // rotate(-90deg) === matrix(0, -1, 1, 0, 0, 0)
    return /matrix\(0,\s*-1,\s*1,\s*0,/.test(t);
  });

  // ---- the sweep tracks the reading
  check("0% draws a sliver, not nothing", () => {
    push(0);
    const s = swept();
    return s > 0 && s < 0.05;
  });
  check("42% sweeps 42%", () => {
    push(42);
    return near(swept(), 0.42, 0.005);
  });
  check("42% is not warn", () => !ring().hasAttribute("data-warn"));
  check("42% shows 42%", () => {
    return document.querySelector(".th-usage__pct").textContent === "42%";
  });
  check("95% sweeps 95%", () => {
    push(95);
    return near(swept(), 0.95, 0.005);
  });
  check("95% flips to warn", () => ring().hasAttribute("data-warn"));
  /* The fixture defines no --cds-* tokens, so this is the fallback red —
     on claude.ai the same rule resolves to the page's own danger fill. */
  check("warn stroke is the danger red", () => {
    return getComputedStyle(ring()).stroke === "rgb(220, 60, 61)";
  });
  /* The middle stage, between the accent and the red: from 75%, the page's
     warning yellow (its fallback here). */
  check("80% is the caution yellow, not warn", () => {
    push(80);
    return ring().hasAttribute("data-caution") && !ring().hasAttribute("data-warn") &&
      getComputedStyle(ring()).stroke === "rgb(251, 179, 21)";
  });
  check("74% is still the accent", () => {
    push(74);
    return !ring().hasAttribute("data-caution") && getComputedStyle(ring()).stroke === "rgb(37, 125, 224)";
  });

  /* ---- footprint. The whole point of the ring, and the constraint the
     control is built around: it has to sit on the mic's line and stay there.

     Measured at a normal reading and before the spent block, which latches
     irreversibly. The bound is 72px rather than a round 90 because the control
     is meant to be exactly one size — ring 15 + gap 6 + two tabular digits and
     a percent sign + 16 of padding, which comes to 63 — and a check that
     allowed 90 would pass right through the countdown coming back. */
  /* An icon-button square, like Claude Code's ring: the fixture has no
     --cds-h-control, so the 28px fallback. */
  check("control is a 28px square", () => {
    push(42);
    const r = bar().getBoundingClientRect();
    return Math.round(r.width) === 28 && Math.round(r.height) === 28;
  });
  check("percentage is not painted, but is in the title", () => {
    const pct = document.querySelector(".th-usage__pct").getBoundingClientRect();
    return pct.width <= 1 && pct.height <= 1 && /^42% /.test(bar().title);
  });
  check("width does not change with the reading", () => {
    push(7);
    const narrow = bar().getBoundingClientRect().width;
    push(95);
    const wide = bar().getBoundingClientRect().width;
    /* Tabular figures, so 7% and 95% differ by one glyph's advance at most.
       Anything larger means something in the control grew with its content —
       which is what put the row at risk of a second line. */
    return Math.abs(wide - narrow) <= 8;
  });
  check("nothing in the control but the ring and the percentage", () => {
    const kept = [...bar().children].filter(
      (c) => !c.classList.contains("th-usage__popover")
    );
    return (
      kept.length === 2 &&
      kept[0].classList.contains("th-usage__ring") &&
      kept[1].classList.contains("th-usage__pct")
    );
  });
  check("reset time is on the title instead", () => {
    push(42);
    return /resets in \d/i.test(bar().title);
  });
  check("control row did not wrap", () => {
    const row = document.querySelector(".row");
    return row.scrollWidth <= row.clientWidth + 1;
  });
  check("gauge is on the mic's line", () => {
    const g = bar().getBoundingClientRect();
    const m = document.getElementById("mic").getBoundingClientRect();
    /* Same line means the vertical centres agree, not merely that the boxes
       overlap — a wrapped row would still overlap by a pixel or two. */
    return Math.abs((g.top + g.bottom) / 2 - (m.top + m.bottom) / 2) <= 1;
  });

  /* ---- composer state transitions.

     The bug these exist for: submitting a prompt does not relabel the send
     button, it swaps it for a stop button, and Claude does not keep the
     dictation button mounted throughout either. Both anchors went missing at
     once, the cascade fell through to the row, and the row's old midpoint seam
     put the gauge in the geometric middle of the composer — then back beside
     the mic when the response finished. Twice a prompt, and further adrift the
     wider the window.

     These run before the destructive cascade checks below, because they need
     the composer intact. Each leaves it in a valid state for the next. */

  // Where the gauge is, relative to the row: near the right end, or adrift?
  function nearerRightEdge() {
    const g = bar().getBoundingClientRect();
    const row = document.querySelector(".row").getBoundingClientRect();
    return row.right - g.right < g.left - row.left;
  }

  function order() {
    return [...document.querySelector(".row__right").children].map(
      (c) => c.id || c.className
    );
  }

  check("dictation active → ring holds its place beside the mic", async () => {
    globalThis.__state("dictating");
    await settle();
    return bar().nextElementSibling === document.getElementById("mic");
  });
  check("dictation active → ring is still on the controls' line", () => {
    const g = bar().getBoundingClientRect();
    const m = document.getElementById("mic").getBoundingClientRect();
    return Math.abs((g.top + g.bottom) / 2 - (m.top + m.bottom) / 2) <= 1;
  });

  check("submitted → ring does not jump to the middle", async () => {
    /* The frame the bug lived in: send gone, stop not yet mounted, dictation
       torn down. Nothing in the cascade resolves, and the only right answer is
       to not move at all. */
    const before = bar().parentElement;
    globalThis.__state("submitting");
    await settle();
    return bar().parentElement === before && nearerRightEdge();
  });
  check("submitted → ring stayed in the control row", () => !!bar().closest(".row"));

  check("generating → ring sits between stop and the mic", async () => {
    globalThis.__state("generating");
    await settle();
    /* Claude renders stop to the left of the dictation button, so anchoring on
       the mic puts the gauge immediately right of the stopper — beside it,
       which is where it is asked to be, and what the screenshots show. */
    return String(order()) === String(["stop", "th-usage", "mic"]);
  });
  check("generating → ring is beside the stopper, not adrift", () => {
    const g = bar().getBoundingClientRect();
    const s = document.getElementById("stop").getBoundingClientRect();
    return g.left - s.right < 24 && nearerRightEdge();
  });

  check("stopped → ring returns to idle without moving", async () => {
    const was = bar().getBoundingClientRect();
    globalThis.__state("idle");
    await settle();
    const now = bar().getBoundingClientRect();
    /* Back in front of the mic, on the same line. Not the same x: idle puts
       send back to the right of the mic, and a right-aligned cluster that
       gains a button moves everything left of it by that button's width.
       This used to demand an unmoved box and failed on every run for that
       reason — the gauge was where it belonged; the check was wrong. */
    return (
      bar().nextElementSibling === document.getElementById("mic") &&
      Math.abs(now.top - was.top) <= 1
    );
  });

  check("a whole prompt cycle never re-parents the ring", async () => {
    const home = bar().parentElement;
    let moved = 0;
    for (const state of ["dictating", "submitting", "generating", "idle"]) {
      globalThis.__state(state);
      await settle();
      if (bar().parentElement !== home) moved += 1;
    }
    return moved === 0 && !!bar().closest(".row");
  });

  /* ---- the anchor cascade, a rung at a time.

     These mutate the DOM, so they run after every position assertion above.
     Each one removes the control the previous rung anchored to and waits for
     usage.js to reposition, which is the failure the cascade exists for: a
     composer that has been rebuilt without the button we were holding on
     to.

     What a missing control costs has changed, and deliberately. The gauge now
     gives up a rung only when the place it is standing has actually stopped
     existing — not merely when something better-named has gone — because
     moving on every blink is what made it jump during a prompt. So a control
     disappearing out from under it is a no-op where the position is still
     valid, and a real re-home where it is not. Both are checked. */
  check("no mic → still sits in front of send", async () => {
    document.getElementById("mic").remove();
    await settle();
    const send = document.getElementById("send");
    return bar().nextElementSibling === send && bar().parentElement === send.parentElement;
  });
  check("no mic or send → holds the cluster rather than dropping a rung", async () => {
    document.getElementById("send").remove();
    await settle();
    /* Nothing left to anchor to, but the cluster it is in is still laid out
       and still inside the row — so there is nothing to gain by moving and a
       visible jump to be paid for it. */
    return !!bar().closest(".row") && nearerRightEdge();
  });
  check("cluster destroyed → re-homes into the control row", async () => {
    /* The other half of the contract. Holding position must not mean freezing:
       when the parent goes, so does the rung, and the gauge finds the row
       again on its own. */
    document.querySelector(".row__right").remove();
    await settle();
    return bar().isConnected && bar().parentElement.classList.contains("row");
  });
  check("row fallback is stable across a re-render", async () => {
    /* The position has to survive the next mutation. It did not: toolbarRow()
       skipped any candidate containing the gauge, so the pass after the gauge
       landed in the row found no row, re-parented it to the composer, and the
       pass after that put it back — a flip on every keystroke. */
    const where = bar().parentElement;
    const next = bar().nextElementSibling;
    document.querySelector(".editor").append(document.createTextNode(" "));
    await settle();
    return bar().parentElement === where && bar().nextElementSibling === next;
  });
  check("still one gauge after all of that", () => {
    return document.querySelectorAll(".th-usage").length === 1;
  });

  // ---- spent. Last, because applyLatch() pins every later reading to full.
  check("spent closes the ring", () => {
    push(100, { exceeded: true });
    return near(swept(), 1, 0.005);
  });
  check("spent turns the percentage red", () => {
    const pct = document.querySelector(".th-usage__pct");
    return (
      bar().hasAttribute("data-spent") &&
      getComputedStyle(pct).color === "rgb(241, 119, 120)"
    );
  });
  check("spent keeps the percentage readable", () => {
    return document.querySelector(".th-usage__pct").textContent === "100%";
  });
  check("spent keeps the ring visible", () => {
    const r = document.querySelector(".th-usage__ring").getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  check("spent puts the reset clock on the title", () => {
    return /use Claude again at .*\d/i.test(bar().title);
  });
  /* Same size as every other reading. This was the widest state the control
     had — about 119px, because the number was swapped for a phrase — which
     made the row likeliest to break at the one moment the gauge had something
     to say. */
  check("spent is the same width as any other reading", () => {
    return Math.round(bar().getBoundingClientRect().width) === 28;
  });
  check("spent tints the button", () => {
    return getComputedStyle(bar()).backgroundColor !== "rgba(0, 0, 0, 0)";
  });

  // ---- click still opens the popover
  check("click opens the popover", () => {
    bar().click();
    return document.querySelector(".th-usage__popover").hasAttribute("data-open");
  });
  check("popover reports both windows", () => {
    const vals = [...document.querySelectorAll(".th-usage__limit-value")].map(
      (n) => n.textContent
    );
    return vals.length === 2 && vals.every((v) => /^\d+%$/.test(v));
  });
  check("popover is on screen", () => {
    const r = document.querySelector(".th-usage__popover").getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth + 1;
  });
  check("Escape closes it", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return !document.querySelector(".th-usage__popover").hasAttribute("data-open");
  });

  /* Awaited, because the cascade checks have to wait for usage.js to react to
     the DOM they just changed. A sync runner read the position back in the
     same task and saw the pre-move state every time. */
  async function run() {
    const lines = [];
    let pass = 0;
    let fail = 0;

    for (const [name, fn] of checks) {
      let ok;
      let label = name;
      try {
        ok = (await fn()) === true;
      } catch (e) {
        ok = false;
        label = name + " (threw: " + e.message + ")";
      }
      if (ok) pass += 1;
      else fail += 1;
      lines.push((ok ? "PASS  " : "FAIL  ") + label);
    }

    const summary = fail === 0 ? "ALL " + pass + " CHECKS PASSED" : fail + " FAILED, " + pass + " passed";
    const text = summary + "\n\n" + lines.join("\n");
    document.getElementById("out").textContent = text;
    globalThis.__gaugeResult = { pass, fail, summary, text };
  }

  /* The gauge mounts on usage.js's own schedule; give it room, and let the
     ring's 0.4s sweep transition settle so the dashoffset read back is the
     final one rather than a frame mid-animation.

     #look skips the run. The suite ends on the spent block, and applyLatch()
     pins every later reading to full — so once it has run, the stage buttons
     below cannot move the gauge off 100% and the fixture is no use for
     actually looking at the thing. */
  if (location.hash === "#look") {
    document.getElementById("out").textContent =
      "#look — assertions skipped. Use the buttons above.";
    setTimeout(() => push(42), 300);
  } else {
    setTimeout(run, 1200);
  }

  // Manual stage controls, for looking at it.
  const stage = { p0: 0, p42: 42, p95: 95 };
  for (const id in stage) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => push(stage[id]));
  }
  const spentBtn = document.getElementById("pSpent");
  if (spentBtn) spentBtn.addEventListener("click", () => push(100, { exceeded: true }));
})();
