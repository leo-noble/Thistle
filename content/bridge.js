/* ============================================================
   Thistle — bridge.js  (runs in the PAGE, not the extension)

   Session usage lives behind an authenticated claude.ai endpoint.
   A content script's fetch is a different context and doesn't carry
   the session, so the request has to originate from the page itself.
   This wraps fetch to (a) learn the org id from traffic claude.ai
   already makes, and (b) answer usage requests from the content
   script over postMessage.

   Derived from Claude Counter (MIT) — see THIRD_PARTY_NOTICES.md.
   ============================================================ */

(() => {
  "use strict";

  /* Two ways in, and only one of them may take effect.

     The manifest declares this file as a content script in the MAIN world,
     which is the reliable path: it needs no injected <script> tag, so the
     page's Content-Security-Policy has no say in it. Firefox applies the
     page CSP to a moz-extension:// script element loaded from a content
     script, so on a CSP-bearing site like claude.ai the old injection
     route could be refused outright and the gauge would never fill.

     Browsers that predate the `world` key ignore it and run this in the
     content-script sandbox instead, where wrapping fetch would accomplish
     nothing — the sandbox has its own. Extension APIs are the tell: they
     exist in the sandbox and not in the page. Those builds fall through to
     bridge-client's <script> injection, which lands here a second time, so
     the marker below settles which copy owns the page. */
  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  if (runtime && runtime.id) return;

  const FLAG = "data-th-bridge";
  const root = document.documentElement;
  if (root.hasAttribute(FLAG)) return;
  /* Also how bridge-client knows the page is already served, without being
     able to see page globals — an attribute crosses the world boundary. */
  root.setAttribute(FLAG, "1");

  const MARK = "Thistle";
  const originalFetch = window.fetch;

  function post(type, payload) {
    window.postMessage({ th: MARK, type, payload }, "*");
  }

  function respond(requestId, ok, payload, error) {
    window.postMessage({ th: MARK, type: "th:response", requestId, ok, payload, error }, "*");
  }

  function toAbsoluteUrl(input) {
    if (typeof input === "string") {
      return input.startsWith("/") ? "https://claude.ai" + input : input;
    }
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    return "";
  }

  /* The org id never appears in the URL bar, but every API call
     claude.ai makes carries it. Watching traffic is the cheap path —
     it costs no extra request when the app happens to call out. */
  let orgId = null;
  function noteOrgId(url) {
    const match = url.match(/\/api\/organizations\/([^/?]+)/);
    if (match && match[1] !== orgId) {
      orgId = match[1];
      post("th:org", { orgId });
    }
  }

  /* Personal and team orgs can both be present. Capability strings have
     changed names before, so an org is only rejected when it explicitly
     advertises capabilities that exclude chat — never for lacking a key
     this code happens to expect. */
  function pickOrg(orgs) {
    const chatty = orgs.find(
      (o) => o && Array.isArray(o.capabilities) && o.capabilities.some((c) => /chat|claude/i.test(c))
    );
    return chatty || orgs.find((o) => o && o.uuid) || null;
  }

  /* The org id comes from the lastActiveOrg cookie, which the content
     script reads directly — see usage.js. This is only a fallback for the
     case where the cookie is absent (rare, but it happens on a first load
     before the app has written it), so a single unauthenticated-safe probe
     is enough. No retry loop: the cookie path is the one that matters. */
  async function discoverOrgId() {
    if (orgId) return;
    try {
      const res = await originalFetch("https://claude.ai/api/organizations", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) return;
      const orgs = await res.json();
      if (!Array.isArray(orgs) || !orgs.length) return;
      const chosen = pickOrg(orgs);
      if (chosen && chosen.uuid && chosen.uuid !== orgId) {
        orgId = chosen.uuid;
        post("th:org", { orgId });
      }
    } catch (e) {
      /* not signed in, offline, or the shape changed */
    }
  }

  window.fetch = async (...args) => {
    const url = toAbsoluteUrl(args[0]);
    if (url) noteOrgId(url);

    const response = await originalFetch.apply(window, args);

    /* Claude streams the current limit state down the completion SSE.
       Reading it here means the bar updates the moment a reply lands,
       instead of waiting for the next poll. */
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("event-stream")) {
      readLimitFromStream(response);
    }

    return response;
  };

  async function readLimitFromStream(response) {
    try {
      const reader = response.clone().body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const json = JSON.parse(raw);
            if (json && json.type === "message_limit" && json.message_limit) {
              post("th:limit", json.message_limit);
            }
          } catch (e) {
            /* not every data: line is JSON */
          }
        }
      }
    } catch (e) {
      /* best effort — never break claude.ai's own streaming */
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.th !== MARK || data.type !== "th:request") return;

    const { requestId, kind, payload } = data;
    try {
      if (kind === "usage") {
        const id = (payload && payload.orgId) || orgId;
        if (!id) throw new Error("Missing orgId");
        const res = await originalFetch(
          "https://claude.ai/api/organizations/" + id + "/usage",
          { method: "GET", credentials: "include" }
        );
        respond(requestId, true, await res.json(), null);
        return;
      }
      throw new Error("Unknown request kind: " + kind);
    } catch (e) {
      respond(requestId, false, null, (e && e.message) || String(e));
    }
  });

  post("th:ready", {});
  discoverOrgId();
})();
