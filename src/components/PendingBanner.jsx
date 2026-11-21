import { useEffect, useRef, useState } from 'react'
import { pendingCount, onPendingChange, flush } from '../lib/outbox'
import { subscribeConnection } from '../lib/connection'

// ONE VOICE WHEN THE SIGNAL GOES (Chris, 21 November 2026: "how best do
// we present 'no internet connection' on the app to users so they don't
// think the app is broken?").
//
// The app used to say two things at once. This bar said entries would
// be saved and sent later -- calm and true -- while the red notice
// underneath said "Something on this screen did not load" with
// "TypeError: Failed to fetch" beneath it and a Try again button that
// reloads the whole app. The red one wins, and reloading with no signal
// is the worst advice available. LoadFailures now stands down while
// this bar is up, so there is one account of what is happening.
//
// Three things make a stoppage read as a wait rather than a breakage:
// saying what STILL WORKS, saying how old the figures on screen are,
// and closing the loop when it comes back. A banner that just vanishes
// leaves everyone wondering whether their work went anywhere.
const clock = t => new Date(t).toLocaleTimeString('en-NG',
  { hour: '2-digit', minute: '2-digit', hour12: false })

export default function PendingBanner() {
  const [n, setN] = useState(pendingCount())
  const [conn, setConn] = useState({ online: true, lastOkAt: null, cameBackAt: null })
  const [sent, setSent] = useState(0)       // how many went when it returned
  const waiting = useRef(0)                 // what was queued while down

  useEffect(() => onPendingChange(setN), [])
  useEffect(() => subscribeConnection(setConn), [])

  // Remember what was queued while there was no signal, so the all-clear
  // can say how many went rather than just disappearing.
  useEffect(() => { if (!conn.online) { waiting.current = Math.max(waiting.current, n) } }, [conn.online, n])
  useEffect(() => {
    if (conn.online && n === 0 && waiting.current > 0) {
      setSent(waiting.current)
      waiting.current = 0
      const t = setTimeout(() => setSent(0), 6000)
      return () => clearTimeout(t)
    }
  }, [conn.online, n])

  // Nudge the queue the moment the connection returns.
  useEffect(() => { if (conn.online) flush() }, [conn.online, conn.cameBackAt])

  if (!conn.online) {
    return (
      <div className="px-5 py-2 bg-raise border-b border-amber/40 text-ink text-sm">
        <div className="mx-auto max-w-md">
          <b>No connection.</b>{' '}
          {n
            ? `Keep going — ${n} ${n === 1 ? 'entry' : 'entries'} saved here will send when the signal returns.`
            : 'Keep going — what you record is saved here and sends when the signal returns.'}
          {conn.lastOkAt && (
            <span className="block text-dim text-xs mt-0.5">
              Figures are from {clock(conn.lastOkAt)} and may have changed.
            </span>
          )}
        </div>
      </div>
    )
  }

  if (n) {
    return (
      <div className="px-5 py-2 bg-amber text-bg text-sm text-center font-semibold">
        Sending {n} {n === 1 ? 'entry' : 'entries'}…
      </div>
    )
  }

  if (sent) {
    return (
      <div className="px-5 py-2 bg-raise text-leaf text-sm text-center font-semibold">
        Back online — {sent} {sent === 1 ? 'entry' : 'entries'} sent
      </div>
    )
  }

  return null
}
