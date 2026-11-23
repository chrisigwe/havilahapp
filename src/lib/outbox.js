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

// REFUSED WRITES ARE KEPT, NOT THROWN AWAY (Chris, 23 November 2026).
//
// A job that reaches the server and is turned down for a reason that is
// not the connection used to be dropped here with a line in the
// console. Nobody reads the console. A sale queued on a weak signal on
// Friday and flushed on Monday, into a day the till had already closed,
// simply ceased to exist -- and the barman who made it had already seen
// "saved, will send when you are back online".
//
// Repayments were given the GM's queue for exactly this in November.
// Sales, stock movements, write-offs and count lines never were. So
// everything refused now lands here instead, with the server's own
// sentence attached, and is shown to the person who made it until they
// deal with it.
const REFUSED_KEY = 'havilah.outbox.refused.v1'
const refusedListeners = new Set()

export const refusedJobs = () => {
  try { return JSON.parse(localStorage.getItem(REFUSED_KEY) || '[]') } catch { return [] }
}
const writeRefused = (q) => {
  try { localStorage.setItem(REFUSED_KEY, JSON.stringify(q)) } catch { /* storage full or blocked */ }
  refusedListeners.forEach(f => f(q.length))
}
export const refusedCount = () => refusedJobs().length
export function onRefusedChange(fn) { refusedListeners.add(fn); return () => refusedListeners.delete(fn) }

const refuse = (job, reason) => {
  const q = refusedJobs()
  q.push({ ...job, refused_at: new Date().toISOString(), reason: String(reason || '') })
  writeRefused(q)
}

// Acknowledged by a person, which is the only thing that removes it.
export function dismissRefused(id) {
  writeRefused(refusedJobs().filter(j => j.id !== id))
}

// Back into the queue to try again -- for the case where the reason has
// since been dealt with, a day reopened or a limit raised. It keeps its
// original id and client reference, so a job that did land after all
// cannot be written twice.
export function retryRefused(id) {
  const job = refusedJobs().find(j => j.id === id)
  if (!job) return
  writeRefused(refusedJobs().filter(j => j.id !== id))
  const { reason, refused_at, ...clean } = job
  const q = read()
  q.push(clean)
  write(q)
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
      // Queued by a newer version of the app than the one flushing it.
      // Kept rather than dropped: it is somebody's sale.
      if (!fn) { refuse(job, 'This version of the app does not know how to send it.'); q.shift(); write(q); continue }
      try {
        await fn(job.payload)
        q = read(); q.shift(); write(q)
      } catch (e) {
        if (isConnectionError(e)) break             // still offline, try later
        refuse(job, e?.message)                     // refused: kept for a person to see
        q = read(); q.shift(); write(q)
      }
    }
  } finally { running = false }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', flush)
  setInterval(flush, 30000)
}
