// Injected before the page loads in the Mac app: stands in for the Chrome extension APIs core.js and popup.js use.
(() => {
  const native = (msg) => window.webkit.messageHandlers.native.postMessage(msg);
  document.documentElement.classList.add("mac-app");   // Mac-only layout tweaks in popup.css

  globalThis.chrome = {
    storage: {
      local: {
        // chrome.storage.local.get(key) → { key: value }; stored natively as JSON text in UserDefaults
        async get(key) {
          const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key ?? {});
          const out = {};
          for (const k of keys) {
            const json = await native({ op: "get", key: k });
            if (json != null) out[k] = JSON.parse(json);
          }
          return out;
        },
        async set(items) {
          const json = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)]));
          await native({ op: "set", items: json });
        },
      },
    },
    runtime: {
      // popup.js asks the extension's background worker to refresh the badge; here the page does it itself
      async sendMessage(msg) {
        if (msg === "refresh-badge") globalThis.__updateBadge?.();
      },
    },
  };

  // Page errors go to the system log (Console.app, "Appliance Timer page")
  const report = (text) => native({ op: "log", text: String(text) }).catch(() => {});
  addEventListener("error", (e) => report(`${e.message} (${e.filename}:${e.lineno})`));
  addEventListener("unhandledrejection", (e) => report(e.reason?.stack ?? e.reason));

  // Exact server time, read natively (a web page can't see the Date header, and Cloudflare blocks page requests)
  globalThis.applianceTimerNative = {
    async networkTime() {
      const r = await native({ op: "time" });
      if (!r) throw new Error("no network time");
      return r;
    },
    badge: (text, title) => native({ op: "badge", text, title }),
    // macOS notifications: "status" | "request" → "authorized" | "denied" | "notDetermined"
    notifications: (action) => native({ op: "notify-auth", action }),
    // Replace all scheduled alerts with these: [{id, at (epoch ms), title, body}]
    schedule: (items) => native({ op: "schedule", items }),
    // Opens an .ics file in Calendar (the web page can't download files here)
    openICS: (name, text) => native({ op: "ics", name, text }),
  };
})();
