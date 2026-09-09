/* ============================================================
   Thistle — export.js
   Context transfer. Reads the open conversation out of the DOM,
   renders it as Markdown, and exposes an API the popup calls via
   chrome.scripting.executeScript.

   Reading the DOM rather than the API keeps this working for
   whatever is actually on screen, including a conversation that
   hasn't been persisted yet.
   ============================================================ */

(() => {
  "use strict";

  /* Claude labels the human turn but not its own. Anything inside the
     transcript that isn't a user turn is therefore Claude's — which
     stays true across the class renames that break exact selectors.

     The exact testid and font class are still listed first, because when
     they are present they are unambiguous. The looser forms after them
     describe the same two things more generally, so a rename that keeps
     Claude's naming convention costs nothing. Each still requires two
     independent words to match, which is what keeps an unrelated
     "user-avatar" or "font-claude-display" out. */
  const USER_SELECTOR = [
    '[data-testid="user-message"]',
    '[data-testid*="user-message" i]',
    '[data-testid*="human-message" i]',
    '[data-testid*="user-turn" i]',
  ].join(",");

  const ASSISTANT_SELECTOR = [
    '[class*="font-claude" i]',
    '[data-testid*="assistant-message" i]',
    '[data-testid*="claude-message" i]',
    '[data-testid*="assistant-turn" i]',
    "[data-is-streaming]",
  ].join(",");

  function transcriptRoot() {
    return document.querySelector("main") || document.body;
  }

  /* Walk both kinds in one pass so turns come out in document order.
     Collecting users then assistants and concatenating would put the
     whole conversation out of sequence. */
  function extractTurns() {
    const root = transcriptRoot();
    if (!root) return [];

    const nodes = root.querySelectorAll(USER_SELECTOR + ", " + ASSISTANT_SELECTOR);
    const turns = [];

    for (const node of nodes) {
      // A match nested inside an earlier match would duplicate its text.
      if (turns.some((t) => t.node.contains(node))) continue;

      const isUser = node.matches(USER_SELECTOR);

      /* An assistant match that contains a user turn is a wrapper, not a
         reply. The loose end of the assistant list makes that reachable —
         [data-is-streaming] and a generic "-turn" testid can both land on a
         container holding the prompt as well as the response — and taking it
         at face value would fold the whole exchange into a single turn with
         the user's own words attributed to Claude. Skip it; the inner
         matches follow in document order and are read on their own.

         Only this direction is guarded. The user list requires both
         "user"/"human" and "message"/"turn", so it cannot match a transcript
         wrapper, and rejecting a user turn for containing an assistant match
         would drop it outright if Claude ever styles prompt text with one of
         its font-claude classes. */
      if (!isUser && node.querySelector(USER_SELECTOR)) continue;

      const text = (node.innerText || node.textContent || "").trim();
      if (!text) continue;

      turns.push({
        node,
        role: isUser ? "user" : "assistant",
        text,
      });
    }

    return turns;
  }

  function conversationTitle() {
    const heading = document.querySelector("main h1, [data-testid*='chat-title' i]");
    const fromHeading = heading && heading.textContent.trim();
    if (fromHeading) return fromHeading;
    return (document.title || "Claude conversation").replace(/\s*[-–|]\s*Claude\s*$/i, "").trim();
  }

  function toMarkdown(turns, { heading = true } = {}) {
    const parts = [];
    if (heading) {
      parts.push("# " + conversationTitle());
      parts.push("_Exported from claude.ai on " + new Date().toLocaleString() + "_");
    }
    for (const turn of turns) {
      parts.push("## " + (turn.role === "user" ? "User" : "Claude"));
      parts.push(turn.text);
    }
    return parts.join("\n\n");
  }

  /* Transfer targets get a short instruction line first. Pasted bare,
     a transcript reads as something the model should continue writing;
     the preamble makes it context to pick up from instead. */
  const PREAMBLE =
    "Below is a conversation I had with Claude. Read it for context, then continue " +
    "helping me from where it left off. Reply only when you have read it.";

  const FORMATTERS = {
    markdown: (turns) => toMarkdown(turns),
    chatgpt: (turns) => PREAMBLE + "\n\n---\n\n" + toMarkdown(turns, { heading: false }),
    gemini: (turns) => PREAMBLE + "\n\n---\n\n" + toMarkdown(turns, { heading: false }),
    grok: (turns) => PREAMBLE + "\n\n---\n\n" + toMarkdown(turns, { heading: false }),
  };

  function getText(format) {
    const turns = extractTurns();
    if (!turns.length) return null;
    const render = FORMATTERS[format] || FORMATTERS.markdown;
    return render(turns);
  }

  function slugify(text) {
    return (
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "conversation"
    );
  }

  /* The download runs page-side on purpose: a blob URL created in the
     popup dies the moment the popup closes, which is immediately.

     Returns the filename rather than a bare true, so the popup can name the
     file it just saved. Still falsy on failure, which is all the caller
     tested for before. */
  function download() {
    const text = getText("markdown");
    if (!text) return false;

    const filename = slugify(conversationTitle()) + ".md";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
  }

  function stats() {
    const turns = extractTurns();
    let words = 0;
    for (const turn of turns) {
      const matched = turn.text.match(/\S+/g);
      words += matched ? matched.length : 0;
    }
    return { turns: turns.length, words };
  }

  async function usage() {
    const TH = globalThis.Thistle;
    if (!TH || !TH.bridge) return null;
    try {
      const snapshot = await TH.usageSnapshot();
      return snapshot || null;
    } catch (e) {
      return null;
    }
  }

  /* On globalThis, not window. In Chrome's isolated world the two are the
     same object, but a Firefox content script sees `globalThis` as its own
     sandbox global and `window` as an Xray wrapper around the page's. The
     sandbox global is the one every content script from this extension
     shares — and the one scripting.executeScript injects into — so hanging
     the surface there is what lets the popup find it in both browsers. */
  globalThis.__thistle = { getText, download, stats, usage };
})();
