/* ============================================================
   Thistle — bridge-client.js
   Content-script side: sends requests into the page context and
   receives events/responses back over postMessage.

   Derived from Claude Counter (MIT) — see THIRD_PARTY_NOTICES.md.
   ============================================================ */

(() => {
  "use strict";

  const TH = (globalThis.Thistle = globalThis.Thistle || {});

  function getRuntime() {
    return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
  }

  function makeRequestId() {
    return Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  class BridgeClient {
    constructor() {
      this._pending = new Map();
      this._listeners = new Map();

      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.th !== "Thistle") return;

        if (data.type === "th:response") {
          const { requestId, ok, payload, error } = data;
          const pending = this._pending.get(requestId);
          if (!pending) return;
          this._pending.delete(requestId);
          clearTimeout(pending.timeoutId);
          if (ok) pending.resolve(payload);
          else pending.reject(new Error(error || "Bridge request failed"));
          return;
        }

        this._emit(data.type, data.payload);
      });
    }

    _emit(type, payload) {
      const listeners = this._listeners.get(type);
      if (!listeners) return;
      for (const fn of listeners) {
        fn(payload);
      }
    }

    on(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
      return () => this._listeners.get(type)?.delete(fn);
    }

    request(kind, payload, { timeoutMs = 10000 } = {}) {
      const requestId = makeRequestId();
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this._pending.delete(requestId);
          reject(new Error("Bridge request timed out (" + kind + ")"));
        }, timeoutMs);

        this._pending.set(requestId, { resolve, reject, timeoutId });
        window.postMessage(
          { th: "Thistle", type: "th:request", requestId, kind, payload },
          "*"
        );
      });
    }

    async requestUsage(orgId) {
      return this.request("usage", { orgId }, { timeoutMs: 15000 });
    }
  }

  let bridgeReadyPromise = null;

  function injectBridgeOnce() {
    if (bridgeReadyPromise) return bridgeReadyPromise;

    const runtime = getRuntime();
    if (!runtime) return Promise.resolve(false);

    if (document.getElementById("th-bridge-script")) {
      return Promise.resolve(true);
    }

    bridgeReadyPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.id = "th-bridge-script";
      script.src = runtime.getURL("content/bridge.js");
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(script);
    });

    return bridgeReadyPromise;
  }

  TH.bridge = new BridgeClient();
  TH.injectBridgeOnce = injectBridgeOnce;
})();
