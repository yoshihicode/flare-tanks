// Service worker for the PWA (home screen install). Network first, so a new deploy is used right away;
// the cached copy is only a fallback when offline. Only same-origin page files are handled:
// the API, WebSockets and third-party scripts (fonts, Turnstile) always go straight to the network.
const CACHE = "flare-tanks-v3"; // bump when SHELL changes
const SHELL = [
  "/", "/index.html", "/game.js", "/shared.js", "/ghosts.js", "/touch.js", "/interp.js", "/minimap.js", "/sfx.js", "/i18n.js",
  "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png",
];

// Requests this worker may answer (also checked by the smoke test)
function shouldHandle(url, origin) {
  if (url.origin !== origin) return false;
  return !(url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/lobby");
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !shouldHandle(url, self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/"))),
  );
});
