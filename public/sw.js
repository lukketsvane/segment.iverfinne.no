/*
 * Caching strategy, tuned for an ML app whose biggest cost is its model:
 * - /ort/* (version-stamped WASM runtime): cache-first, forever.
 * - /_next/static/* (content-hashed): cache-first.
 * - navigations: network-first with cache fallback, so deploys are picked up
 *   immediately but the app still opens offline / on flaky cellular.
 * Everything else (analytics, etc.) passes through untouched.
 */
// The weights themselves are cached by the engine under segment-models-v1,
// keyed by a commit-pinned URL; this only covers the runtime and the shell.
const VERSION = "v2"
const RUNTIME_CACHE = `runtime-${VERSION}`
const STATIC_CACHE = `static-${VERSION}`
const SHELL_CACHE = `shell-${VERSION}`
const KEEP = new Set([RUNTIME_CACHE, STATIC_CACHE, SHELL_CACHE])

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => !KEEP.has(name)).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    if (cached) return cached
    const home = await cache.match("/")
    if (home) return home
    return Response.error()
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/ort/")) {
    event.respondWith(cacheFirst(RUNTIME_CACHE, request))
    return
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(STATIC_CACHE, request))
    return
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request))
  }
})
