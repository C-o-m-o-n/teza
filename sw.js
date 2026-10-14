// TEZA service worker: precaches the static build so the game runs offline after the first load.
// build.mjs replaces __BUILD_ID__ with a content hash of the build, so every new build gets a new cache
// (and a byte-different sw.js, which makes browsers install the update).
// It never touches /api/*: those requests (accounts with cookies, match WebSockets) go straight to the network.
const CACHE = "teza-__BUILD_ID__";

const PRECACHE = [
  "./",
  "index.html",
  "style.css",
  "game.js",
  "manifest.webmanifest",
  "fonts/russo-one-400.woff2",
  "fonts/saira-semi-condensed-400.woff2",
  "fonts/saira-semi-condensed-600.woff2",
  "fonts/saira-semi-condensed-700.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon-180.png",
];

/** Only same-origin GETs outside /api/ that aren't WebSocket upgrades. Everything else is not intercepted. */
function shouldHandle(request) {
  if (request.method !== "GET") return false;
  if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return !url.pathname.startsWith("/api/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE.map(async (path) => {
          const res = await fetch(new Request(path, { cache: "reload" }));
          if (!res.ok) throw new Error(`precache ${path}: ${res.status}`);
          // A redirected response (e.g. a host redirecting index.html to /) can't answer a navigation,
          // so store a plain copy of it.
          const body = res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
          await cache.put(path, body);
        }),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!shouldHandle(request)) return;
  // Cache-first from the precache, then the network. Nothing fetched here is written to the cache.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (err) {
        if (request.mode === "navigate") {
          const shell = await cache.match("index.html");
          if (shell) return shell;
        }
        throw err;
      }
    }),
  );
});
