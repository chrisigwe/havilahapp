import { useCallback, useEffect, useRef, useState } from 'react'
import { naira } from '../lib/format'
import { loadRoomChargesByStatus, approveRoomCharge, rejectRoomCharge } from '../lib/data'
import { useToast } from './Toast'
import { pulseAlert } from '../lib/alert'

// Room charges over the branch limit, made by bar staff, waiting for the
// front desk. Nothing here is on a guest's bill until approved.
//
// Refusing requires a reason: the bartender has to go back to the guest
// and collect it another way, and needs to know why. The database
// enforces the same (reject_room_charge refuses a blank reason).
export default function RoomChargeApprovals({ branchId, onDecided }) {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [rejecting, setRejecting] = useState(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(null)

  // Ids already known. null until the first load, so charges waiting
  // when the page opens don't all chime at once as if newly arrived.
  const known = useRef(null)

  const refresh = useCallback(() => {
    loadRoomChargesByStatus(branchId, 'pending').then(next => {
      setRows(next)
      const prev = known.current
      known.current = new Set(next.map(r => r.id))
      if (!prev) return
      const arrived = next.filter(r => !prev.has(r.id))
      if (!arrived.length) return
      // Chime and say what came in, so the front desk knows without the
      // bartender having to ring through on the intercom.
      pulseAlert({ variant: 'attention' })
      const r = arrived[arrived.length - 1]
      toast(arrived.length === 1
        ? `New room charge to approve · Room ${r.room} · ${naira(r.total)}${r.servedBy ? ` (${r.servedBy})` : ''}`
        : `${arrived.length} new room charges to approve`, 'info', { duration: 10000 })
    }).catch(() => setRows([]))
  }, [branchId, toast])

  // Every 15 s rather than every minute: a bartender and a guest are
  // standing waiting for this decision.
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  async function approve(r) {
    setBusy(r.id)
    try {
      await approveRoomCharge(r.id)
      toast(`Approved · Room ${r.room} · ${naira(r.total)}`, 'success')
      refresh(); onDecided?.()
    } catch (e) { toast(e.message, 'error') }
    setBusy(null)
  }

  async function reject(r) {
    if (!reason.trim()) { toast('Give a reason for the bartender', 'error'); return }
    setBusy(r.id)
    try {
      await rejectRoomCharge(r.id, reason.trim())
      toast(`Refused · the bar will collect ${naira(r.total)}`, 'success')
      setRejecting(null); setReason('')
      refresh(); onDecided?.()
    } catch (e) { toast(e.message, 'error') }
    setBusy(null)
  }

  if (!rows?.length) return null

  return (
    <div className="mt-3 rounded-2xl border-2 border-amber bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-semibold">Room charges awaiting approval</p>
        <span className="tnum font-bold">{rows.length}</span>
      </div>
      <p className="text-dim text-xs mt-1 mb-2">
        Not on any guest's bill until you approve. Check with the guest if unsure.
      </p>

      {rows.map(r => (
        <div key={r.id} className="py-3 border-t border-line/60 first:border-0">
          <div className="flex justify-between gap-2">
            <span className="font-semibold truncate">Room {r.room} · {r.guest}</span>
            <span className="tnum font-bold shrink-0">{naira(r.total)}</span>
          </div>
          <div className="text-dim text-xs mt-0.5">
            {r.servedBy && <>by {r.servedBy} · </>}
            {r.items.map(i => `${i.description} ×${Number(i.qty)}`).join(', ')}
          </div>

          {rejecting === r.id ? (
            <div className="mt-2">
              <input value={reason} autoFocus onChange={e => setReason(e.target.value)}
                placeholder="Reason — e.g. guest says it isn't theirs"
                className="h-11 w-full px-3 rounded-xl bg-raise border border-line text-sm" />
              <div className="flex gap-2 mt-2">
                <button onClick={() => reject(r)} disabled={busy === r.id}
                  className="flex-1 h-10 rounded-lg bg-clay text-bg font-bold text-sm disabled:opacity-40">
                  Refuse
                </button>
                <button onClick={() => { setRejecting(null); setReason('') }}
                  className="flex-1 h-10 rounded-lg border border-line text-dim text-sm">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 mt-2">
              <button onClick={() => approve(r)} disabled={busy === r.id}
                className="flex-1 h-10 rounded-lg bg-amber text-bg font-bold text-sm disabled:opacity-40">
                Approve
              </button>
              <button onClick={() => { setRejecting(r.id); setReason('') }} disabled={busy === r.id}
                className="flex-1 h-10 rounded-lg border border-clay text-clay font-semibold text-sm">
                Refuse
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
