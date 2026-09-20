// Detects a new deployed version and offers a one-tap refresh, rather
// than reloading the page out from under someone mid-task (an open
// basket, a half-filled sheet). The service worker itself already
// activates a new version immediately (skipWaiting() in sw.js) — this
// just (a) actively checks for one periodically, since a long-lived
// open tab can't rely on the browser's own infrequent background
// checks, and (b) notifies the app once a new version has taken over.

let listeners = []
export function onUpdateAvailable(cb) { listeners.push(cb); return () => { listeners = listeners.filter(l => l !== cb) } }
function notify() { listeners.forEach(l => l()) }

export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', async () => {
    let reg
    try {
      reg = await navigator.serviceWorker.register('/sw.js')
    } catch {
      return  // non-fatal — app works without it, just without offline shell caching
    }
    // Check for a new version every 5 minutes — catches updates
    // during a long-open shift without waiting on the browser's own
    // update schedule, which can be much less frequent.
    setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000)
  })
  // Fires once a new service worker has actually taken control —
  // the fresh version is already active at this point, so a reload
  // (when the person taps the banner) is all that's needed.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (window.__swUpdateNotified) return   // guard: only ever notify once per new version
    window.__swUpdateNotified = true
    notify()
  })
}
