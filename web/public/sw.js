// Network-first with a cached fallback, plus Web Push. Bump BUILD on every deploy.
const BUILD = "mint-v5";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== BUILD).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(BUILD).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? Response.error())),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data?.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Mint", {
      body: d.body || "",
      tag: d.tag || "cardthief",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: d.url || "/", buyUrl: d.buyUrl || null },
      requireInteraction: Boolean(d.urgent),
      renotify: true,
      vibrate: d.urgent ? [300, 100, 300, 100, 300] : [200],
      actions: d.buyUrl ? [{ action: "buy", title: "Buy on eBay" }, { action: "open", title: "Details" }] : [],
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  // A plain tap on an eBay steal opens the listing; "Details" opens Mint.
  const target = e.action !== "open" && data.buyUrl ? data.buyUrl : data.url || "/";
  if (target.startsWith("http") && !target.startsWith(self.location.origin)) {
    e.waitUntil(self.clients.openWindow(target));
    return;
  }
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) { c.navigate(target); return c.focus(); }
      return self.clients.openWindow(target);
    }),
  );
});
