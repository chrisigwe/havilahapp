// Havilah App service worker.
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
      // Only cache GOOD responses. It used to cache everything, so a 404
      // or 500 served during a deploy would be stored and then handed
      // back in place of the real file the next time the phone was
      // offline. A failed write (storage full) must not break the page.
      if (fresh.ok) {
        const clone = fresh.clone()
        caches.open(SHELL_CACHE).then(c => c.put(e.request, clone)).catch(() => {})
      }
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

// ---------- Web Push ----------
// These fire when the app is CLOSED or backgrounded. The in-page
// pulseAlert/setAppBadge in App.jsx only run while the app is open;
// a service worker is the only way a phone can alert on its home
// screen icon without the app running.
self.addEventListener('push', (e) => {
  let payload = {}
  try { payload = e.data ? e.data.json() : {} } catch { payload = {} }
  const count = Number(payload.count || 0)
  const title = payload.title || 'Havilah App'
  const body = payload.body || 'You have items needing attention.'

  e.waitUntil((async () => {
    // Badge the home screen icon. Supported on installed PWAs
    // (Android/Chrome, iOS 16.4+); harmless no-op elsewhere.
    try {
      if (count > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(count)
      else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge()
    } catch { /* unsupported */ }

    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/mask-icon.svg',
      // Same tag so repeated pushes REPLACE rather than stack up —
      // this is a running count, not a feed of separate events.
      tag: 'havilah-pending',
      renotify: true,
      vibrate: [80, 60, 80],
      data: { url: payload.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Focus an already-open window instead of opening a second copy.
    for (const c of all) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url); return }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
