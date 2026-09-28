import { useCallback, useEffect, useRef, useState } from 'react'
import { naira } from '../lib/format'
import { loadRoomChargesByStatus, loadOrderOutcomes } from '../lib/data'
import { pulseAlert } from '../lib/alert'
import { useToast } from './Toast'

// The bartender's own room charges waiting for the front desk.
//
// A toast was the wrong tool: it vanished in seconds, leaving him
// unsure whether anything had happened and likely to ring the front
// desk to check. This stays on screen for exactly as long as the charge
// is waiting, then chimes and says what happened — so he knows to
// expect a reply and hears it arrive.
//
// Polls every 15 s: short enough that a decision reaches him quickly,
// light enough (one small query) to leave running all shift.
export default function MyPendingRoomCharges({ branchId, staffId, onDecided }) {
  const toast = useToast()
  const [mine, setMine] = useState([])
  // null until the first load, so charges already waiting when the page
  // opens are not announced as if they had just been decided.
  const seen = useRef(null)

  const refresh = useCallback(async () => {
    let rows = []
    try { rows = await loadRoomChargesByStatus(branchId, 'pending') } catch { return }
    const own = rows.filter(r => r.servedById === staffId)
    setMine(own)

    const now = new Set(own.map(r => r.id))
    const prev = seen.current
    seen.current = now
    if (!prev) return

    // Left the pending list since last time = the front desk decided.
    const decided = [...prev].filter(id => !now.has(id))
    if (!decided.length) return
    const outcomes = await loadOrderOutcomes(decided)
    for (const o of outcomes) {
      if (o.status === 'approved') {
        pulseAlert({ variant: 'resolved' })
        toast(`Approved · Room ${o.room} — it's on the guest's bill.`, 'success', { duration: 12000 })
      } else if (o.status === 'rejected') {
        pulseAlert({ variant: 'attention' })
        toast(`Refused · Room ${o.room}${o.note ? ` — ${o.note}` : ''}. Collect payment below.`,
              'error', { duration: 15000 })
      }
    }
    onDecided?.()
  }, [branchId, staffId, toast, onDecided])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  if (!mine.length) return null

  const mins = (ts) => Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000))

  return (
    <div className="mt-3 rounded-2xl border-2 border-amber bg-surface p-4">
      <div className="flex items-center gap-2">
        {/* Pulsing dot: this is live and still waiting, not a leftover. */}
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber" />
        </span>
        <p className="font-semibold">Waiting for front desk</p>
      </div>
      <p className="text-dim text-xs mt-1 mb-2">
        Not on the guest's bill yet. You'll hear a chime and see the answer here.
      </p>
      {mine.map(r => (
        <div key={r.id} className="flex justify-between gap-2 py-2 border-t border-line/60 first:border-0">
          <span className="truncate">
            Room {r.room} · {r.guest}
            <span className="text-dim text-xs"> · {mins(r.createdAt)} min ago</span>
          </span>
          <span className="tnum font-bold shrink-0">{naira(r.total)}</span>
        </div>
      ))}
    </div>
  )
}
