// Offline outbox. Writes that fail because the connection dropped are
// kept in localStorage and retried when it returns, so a barman on a
// weak signal never loses a sale.
const KEY = 'havilah.outbox.v1'
const listeners = new Set()

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] } }
const write = (q) => {
  try { localStorage.setItem(KEY, JSON.stringify(q)) } catch { /* storage full or blocked */ }
  listeners.forEach(f => f(q.length))
}

export const pendingCount = () => read().length
export function onPendingChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }

// A dropped connection looks like a TypeError from fetch, or the browser
// already knows it is offline. Anything else is a real error and must
// surface to the user rather than being queued silently.
export function isConnectionError(err) {
  if (!navigator.onLine) return true
  const m = String(err?.message || '').toLowerCase()
  return m.includes('failed to fetch') || m.includes('networkerror')
      || m.includes('load failed') || m.includes('fetch')
}

export function enqueue(job) {
  const q = read()
  q.push({ ...job, id: crypto.randomUUID(), queued_at: new Date().toISOString() })
  write(q)
}

// handlers: { [job.kind]: async (payload) => void }
let handlers = {}
export const registerHandlers = (h) => { handlers = h }

let running = false
export async function flush() {
  if (running || !navigator.onLine) return
  running = true
  try {
    let q = read()
    while (q.length) {
      const job = q[0]
      const fn = handlers[job.kind]
      if (!fn) { q.shift(); write(q); continue }   // unknown job, drop it
      try {
        await fn(job.payload)
        q = read(); q.shift(); write(q)
      } catch (e) {
        if (isConnectionError(e)) break             // still offline, try later
        q = read(); q.shift(); write(q)             // permanent failure, drop
        console.error('Outbox job failed permanently:', job.kind, e)
      }
    }
  } finally { running = false }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', flush)
  setInterval(flush, 30000)
}
