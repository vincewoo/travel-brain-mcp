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

const VERSION = "travel-companion-v1";
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
  if (request.mode === "navigate" && url.pathname.startsWith("/app")) {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.pathname.startsWith("/app/")) event.respondWith(cacheFirst(request));
});
