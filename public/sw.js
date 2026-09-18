// Havilah Inventory service worker.
// Deliberately conservative: it makes the app launch reliably and
// survive brief connection drops, but NEVER caches live data
// (Supabase API calls, auth) — those always go to the network so
// nobody ever sees stale stock, sales, or balances.

const SHELL_CACHE = 'havilah-shell-v1'

// On install, pre-cache nothing heavy — the shell is hashed by Vite
// and will be cached on first fetch. Just take over promptly.
self.addEventListener('install', (e) => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // drop old shell caches on version bump
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Only handle same-origin GETs. Everything else — Supabase API,
  // auth, fonts, POST/PUT/DELETE — goes straight to the network,
  // untouched. This is what keeps data live.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  // Network-first for the app shell: try the network, fall back to
  // cache only if offline. This means a fresh deploy is picked up as
  // soon as there's a connection, never served stale from cache.
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request)
      const cache = await caches.open(SHELL_CACHE)
      cache.put(e.request, fresh.clone())
      return fresh
    } catch (err) {
      const cached = await caches.match(e.request)
      if (cached) return cached
      // last resort for navigations: serve the cached root
      if (e.request.mode === 'navigate') {
        const root = await caches.match('/')
        if (root) return root
      }
      throw err
    }
  })())
})
