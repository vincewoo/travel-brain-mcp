/**
 * The shell cache, and nothing else.
 *
 * Trip data lives in IndexedDB, written by the app after an authenticated MCP call. It is
 * deliberately not cached here: a service worker that replayed a stale `/mcp` response could show
 * yesterday's itinerary as though it were live, and no cache header would make that honest. This
 * worker only makes sure the app itself still opens with the radio off.
 *
 * Assets are content-hashed and therefore immutable, so they are cache-first. Navigations are
 * network-first with a cached fallback, so a deploy is picked up the next time there is signal
 * while an underground train still gets the last known shell.
 */

// Bumping this drops every previously cached entry on activate. That is not housekeeping here: an
// earlier build asked for a map worker the bundle never emitted, the server answered the missing
// path with the shell under a 200, and `cacheFirst` stored that HTML under a `.mjs` URL. The URL
// does not change when the build is fixed, so without a new cache name the stale HTML would go on
// being served to everyone who already has it and the map would stay broken.
//
// v3 is the same problem in its ordinary form: the icons live at fixed, unhashed `/app/icon-*.png`
// URLs, so redrawing them changes the bytes without changing the request. An installed companion
// would keep serving the compass out of the v2 cache until something dropped it.
const VERSION = "travel-companion-v3";
const SHELL = "/app/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll([SHELL, "/app/manifest.webmanifest"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(VERSION)).put(request, response.clone());
  return response;
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(VERSION)).put(SHELL, response.clone());
    return response;
  } catch (error) {
    // Every companion route is client-side, so the shell is the correct answer for all of them.
    const cached = await caches.match(SHELL);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Anything that is not a plain read of this app's own files — the MCP endpoint above all — is
  // left to the network, where a failure is visible instead of quietly served from a cache.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // A worker script is left to the network. It is only ever needed with a live connection — the map
  // it drives cannot draw tiles offline anyway, and `MapPanel` shows the schematic instead — so
  // there is nothing to gain by caching it, and standing between a `new Worker()` and its script is
  // a good way to turn a bad response into a map with no tiles and no error worth the name.
  if (request.destination === "worker" || request.destination === "sharedworker") return;
  if (request.mode === "navigate" && url.pathname.startsWith("/app")) {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.pathname.startsWith("/app/")) event.respondWith(cacheFirst(request));
});
