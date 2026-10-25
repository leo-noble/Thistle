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

  /* Both turns are labelled now. Claude's transcript tags its own replies
     [data-testid="assistant-message"] beside the long-standing
     [data-testid="user-message"], so the exact testids lead and the looser
     forms after them only catch a rename inside the same convention.

     The user list no longer takes a bare *="user-message" substring. Each
     prompt is followed by a sibling [data-testid="user-message-actions"] —
     the copy/edit strip — and the substring claimed that too, so every turn
     was matched twice. It only survived because the strip has no text. */
  const USER_SELECTOR = [
    '[data-testid="user-message"]',
    '[data-testid="human-message"]',
    '[data-testid="user-turn"]',
  ].join(",");

  const ASSISTANT_SELECTOR = [
    '[data-testid="assistant-message"]',
    '[data-testid="claude-message"]',
    '[data-testid="assistant-turn"]',
    '[class*="font-claude-response" i]',
    "[data-is-streaming]",
  ].join(",");

  /* Where a reply's actual prose lives. Everything else inside the message
     is chrome: a visually hidden "Claude responded: …" heading for screen
     readers, tool-status lines ("Read memory", "Created 2 files"), usage
     banners with a "Try again" button, the action bar and its date. All of
     that came out in the export as though Claude had said it.

     Not [data-prose-box], tempting as the name is: the usage-limit banner
     carries it too. */
  const PROSE = ".standard-markdown, .progressive-markdown, .prose";

  /* Never content, wherever it turns up. */
  const CHROME = [
    "button",
    "svg",
    "time",
    "script",
    "style",
    ".sr-only",
    '[role="status"]',
    "[data-find-omitted]",
    '[data-testid$="-actions"]',
    '[data-testid="message-actions"]',
    '[data-testid="message-warning"]',
  ].join(",");

  function transcriptRoot() {
    return document.querySelector('[data-testid="transcript-list"]') ||
      document.querySelector("main") ||
      document.body;
  }

  /* ---- HTML → Markdown --------------------------------------------------

     innerText flattened every reply to plain prose: code lost its fences
     and its language, lists lost their markers, tables became runs of
     tab-separated words. Pasted into another model that is a worse
     transcript than the one on screen, so the rendered Markdown is walked
     back into Markdown instead. Small on purpose — it covers what Claude
     renders, not HTML at large. */

  const BLOCK = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "UL", "OL", "LI", "PRE", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "HR", "FIGURE", "DETAILS",
  ]);

  function isBlock(el) {
    return BLOCK.has(el.tagName) || (el.classList && el.classList.contains("katex-display"));
  }

  function tex(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent.trim() : null;
  }

  function codeLang(pre) {
    const code = pre.querySelector("code") || pre;
    const m = String(code.className || "").match(/language-([\w+#.-]+)/);
    return m ? m[1] : "";
  }

  function fence(pre) {
    const body = (pre.querySelector("code") || pre).textContent.replace(/\n+$/, "");
    const ticks = /```/.test(body) ? "````" : "```";
    return ticks + codeLang(pre) + "\n" + body + "\n" + ticks;
  }

  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    if (el.matches(CHROME)) return "";
    if (el.classList.contains("katex")) {
      const t = tex(el);
      if (t) return "$" + t + "$";
    }

    const inner = () => Array.from(el.childNodes, inline).join("");
    switch (el.tagName) {
      case "BR": return "\n";
      case "STRONG":
      case "B": { const t = inner().trim(); return t ? "**" + t + "**" : ""; }
      case "EM":
      case "I": { const t = inner().trim(); return t ? "*" + t + "*" : ""; }
      case "DEL":
      case "S": { const t = inner().trim(); return t ? "~~" + t + "~~" : ""; }
      case "CODE": return "`" + el.textContent + "`";
      case "A": {
        const t = inner().trim();
        const href = el.getAttribute("href");
        return href && t && !href.startsWith("javascript:") ? "[" + t + "](" + el.href + ")" : t;
      }
      case "IMG": return el.alt ? "![" + el.alt + "](" + el.src + ")" : "";
      default: return inner();
    }
  }

  function indent(text, prefix) {
    return text.split("\n").map((l, i) => (i === 0 ? l : (l ? prefix + l : l))).join("\n");
  }

  function list(el, depth) {
    const ordered = el.tagName === "OL";
    let n = Number(el.getAttribute("start")) || 1;
    const items = [];
    for (const li of el.children) {
      if (li.tagName !== "LI") continue;
      const marker = ordered ? n++ + ". " : "- ";
      const body = blocks(li, depth + 1).join("\n");
      items.push(marker + indent(body, " ".repeat(marker.length)));
    }
    return items.join("\n");
  }

  function table(el) {
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children, (c) => inline(c).trim().replace(/\|/g, "\\|"))
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: width }, (_, i) => r[i] || "").join(" | ") + " |";
    return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
  }

  /* A code block's wrapper also holds its language label and copy button.
     Recursing into it would print the label as a paragraph above the fence,
     so a container that is essentially one <pre> is emitted as just that. */
  function soleCode(el) {
    const pres = el.querySelectorAll("pre");
    if (pres.length !== 1 || el.tagName === "PRE") return null;
    const extra = el.textContent.length - pres[0].textContent.length;
    return extra < 40 ? pres[0] : null;
  }

  function block(el, depth) {
    if (el.matches(CHROME)) return "";
    if (el.classList.contains("katex-display")) {
      const t = tex(el);
      return t ? "$$\n" + t + "\n$$" : "";
    }
    const code = soleCode(el);
    if (code) return fence(code);

    switch (el.tagName) {
      case "PRE": return fence(el);
      case "HR": return "---";
      case "UL":
      case "OL": return list(el, depth);
      case "TABLE": return table(el);
      case "BLOCKQUOTE":
        return blocks(el, depth).join("\n\n").split("\n").map((l) => "> " + l).join("\n");
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        return "#".repeat(Number(el.tagName[1])) + " " + inline(el).trim();
      default:
        return blocks(el, depth).join("\n\n");
    }
  }

  /* Children of a container, as Markdown blocks. Runs of inline content
     between block children become their own paragraph. */
  function blocks(el, depth) {
    const out = [];
    let run = "";
    const flush = () => {
      const t = run.replace(/[ \t]+\n/g, "\n").trim();
      if (t) out.push(t);
      run = "";
    };
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && isBlock(child)) {
        flush();
        const b = block(child, depth);
        if (b && b.trim()) out.push(b);
      } else {
        run += inline(child);
      }
    }
    flush();
    return out;
  }

  function toMd(el) {
    return blocks(el, 0).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* The prose roots of a reply, outermost only — .prose wraps
     .standard-markdown, and reading both would print every reply twice. */
  function proseRoots(node) {
    const found = Array.from(node.querySelectorAll(PROSE)).filter((el) => !el.closest(CHROME));
    return found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
  }

  function assistantText(node) {
    const roots = proseRoots(node);
    if (roots.length) return roots.map(toMd).filter(Boolean).join("\n\n");
    return toMd(node);
  }

  /* Prompts are plain text with white-space: pre-wrap, so innerText is the
     faithful reading — it keeps the user's own line breaks, which the
     Markdown walk would collapse. */
  function userText(node) {
    return (node.innerText || node.textContent || "").trim();
  }

  /* Walk both kinds in one pass so turns come out in document order.
     Collecting users then assistants and concatenating would put the
     whole conversation out of sequence. */
  /* `read` turns a node into its text, and defaults to the full Markdown
     reading. The popup asks for the size of a conversation every time it
     opens, and for that the cheap reading below is enough — see stats(). */
  function extractTurns(read) {
    const root = transcriptRoot();
    if (!root) return [];

    const nodes = root.querySelectorAll(USER_SELECTOR + ", " + ASSISTANT_SELECTOR);
    const turns = [];

    for (const node of nodes) {
      /* A match nested inside an earlier match would duplicate its text.
         Only the latest accepted turn needs asking: nodes arrive in document
         order, so anything nested in an accepted turn arrives before any turn
         after it. Asking all of them made this quadratic in the length of the
         conversation. */
      const last = turns[turns.length - 1];
      if (last && last.node.contains(node)) continue;

      const isUser = node.matches(USER_SELECTOR);

      /* An assistant match that contains a user turn is a wrapper, not a
         reply — [data-is-streaming] can land on a container holding the
         prompt as well as the response. Skip it; the inner matches follow in
         document order and are read on their own. */
      if (!isUser && node.querySelector(USER_SELECTOR)) continue;

      const text = read ? read(node, isUser) : isUser ? userText(node) : assistantText(node);
      if (!text) continue;

      turns.push({ node, role: isUser ? "user" : "assistant", text });
    }

    return turns;
  }

  /* The conversation's name. Not `main h1` any more: in the current layout
     the only h1 is the app's own "Claude" wordmark, so every export was
     titled "Claude". The header's title control comes first, then the tab
     title, which claude.ai sets to "<name> - Claude". */
  function conversationTitle() {
    const header = document.querySelector(
      '[data-testid="session-title-split"], [data-testid*="chat-title" i], [data-testid="chat-header"] h2'
    );
    const fromHeader = header && header.textContent.trim();
    if (fromHeader) return fromHeader;

    const fromTab = (document.title || "").replace(/\s*[-–|]\s*Claude\s*$/i, "").trim();
    if (fromTab && !/^claude$/i.test(fromTab)) return fromTab;

    return "Claude conversation";
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

  const transfer = (turns) => PREAMBLE + "\n\n---\n\n" + toMarkdown(turns, { heading: false });

  const FORMATTERS = {
    markdown: (turns) => toMarkdown(turns),
    chatgpt: transfer,
    gemini: transfer,
    grok: transfer,
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
     file it just saved. Still falsy on failure. */
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

  /* The size of the conversation, for the popup's one-line hint. Not the
     export: that reads each message's laid-out text and walks its Markdown,
     which for a long conversation makes the page lay out hundreds of messages
     and builds a transcript only to count its words — every time the popup
     opens, while it is blank. textContent needs no layout, and the prose
     roots leave out the status lines and banners the export drops too, so
     the count agrees with it to within the odd screen-reader heading. */
  function lean(node, isUser) {
    const roots = isUser ? [node] : proseRoots(node);
    const parts = [];
    for (const root of roots.length ? roots : [node]) {
      /* Text node by text node, joined with a space. textContent runs one
         paragraph's last word into the next paragraph's first ("count.Reply"),
         which undercounts every block boundary in the conversation. */
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
    }
    return parts.join(" ").trim();
  }

  function stats() {
    const turns = extractTurns(lean);
    let words = 0;
    for (const turn of turns) {
      const matched = turn.text.match(/\S+/g);
      words += matched ? matched.length : 0;
    }
    return { turns: turns.length, words, title: conversationTitle() };
  }

  async function usage() {
    const TH = globalThis.Thistle;
    if (!TH || typeof TH.usageSnapshot !== "function") return null;
    try {
      return (await TH.usageSnapshot()) || null;
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
