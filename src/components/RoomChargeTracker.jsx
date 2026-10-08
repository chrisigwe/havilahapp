import { useEffect, useState } from 'react'
import { loadDepartmentRoomCharges } from '../lib/data'
import { naira, lagosToday, lagosTime } from '../lib/format'

const dShort = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : ''
const daysAgo = d => Math.round((new Date(lagosToday()) - new Date(String(d).slice(0, 10))) / 864e5)

// What a department has charged to rooms and whether the money has been
// collected, kept on screen until it is — so a charge sold on Monday is still
// here on Thursday if the guest has not paid it, instead of vanishing with the
// day. Read-only; payments are recorded on the guest's folio at Reception.
export default function RoomChargeTracker({ branchId, locationId = null, refreshKey = 0 }) {
  const [lines, setLines] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!branchId) return
    setLines(null)
    loadDepartmentRoomCharges(branchId, locationId).then(setLines).catch(() => setLines([]))
  }, [branchId, locationId, refreshKey])

  if (!lines) return null
  const owing = lines.filter(l => l.status === 'unpaid' || l.status === 'part')
  const done = lines.filter(l => !(l.status === 'unpaid' || l.status === 'part'))
  if (!owing.length && !done.length) return null
  const owedTotal = owing.reduce((s, l) => s + Math.max(0, Number(l.amount) - Number(l.paid_amt || 0)), 0)
  const shown = showDone ? lines : owing

  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">Room charges awaiting payment</p>
          <p className="text-dim text-sm">
            {owing.length
              ? `${owing.length} item${owing.length === 1 ? '' : 's'} not yet collected`
              : 'Everything charged to rooms has been collected'}
          </p>
        </div>
        {owing.length > 0 && <span className="tnum font-bold text-clay">{naira(owedTotal)}</span>}
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4">
          {!owing.length && !showDone && <p className="text-dim text-sm py-2">Nothing outstanding.</p>}
          <ul className="divide-y divide-line/60">
            {shown.map(l => {
              const left = Math.max(0, Number(l.amount) - Number(l.paid_amt || 0))
              const age = daysAgo(l.date)
              const isOwing = l.status === 'unpaid' || l.status === 'part'
              return (
                <li key={l.id} className="py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">{l.qty} × {l.item}
                        {!locationId && l.dept && <span className="text-dim font-normal"> · {l.dept}</span>}
                      </p>
                      <p className="text-dim text-sm">
                        Room {l.room || '—'}{l.guest ? ` · ${l.guest}` : ''}
                        {l.stay_status === 'checked_out' && isOwing &&
                          <span className="text-clay font-semibold"> · guest has checked out</span>}
                      </p>
                      <p className="text-dim text-sm">
                        Sold {dShort(l.date)}{l.sold_at ? ` ${lagosTime(l.sold_at)}` : ''}
                        {l.sold_by ? ` by ${l.sold_by}` : ''}
                        {isOwing && age > 0 && <span className="text-clay"> · {age} day{age === 1 ? '' : 's'} ago</span>}
                      </p>
                      {l.status === 'part' && (
                        <p className="text-amber text-sm">Part paid — {naira(l.paid_amt)} collected, {naira(left)} to come</p>
                      )}
                      {(l.status === 'paid' || l.status === 'part') && (l.payments || []).map((p, i) => (
                        <p key={i} className="text-leaf text-sm">
                          Collected {naira(p.amount)} by {p.by || 'staff'} · {dShort(p.date)} · {String(p.method || '').toUpperCase()} · {p.dept}
                        </p>
                      ))}
                      {l.status === 'settled_reception' && (
                        <p className="text-amber text-sm">
                          Guest has paid, but Reception took it as its own
                          {(l.payments || []).length ? ` (${l.payments.map(p => `${p.by || 'staff'}, ${dShort(p.date)}`).join('; ')})` : ''}.
                          Ask the front desk to move that payment to {l.dept || 'your department'} so it counts in your total.
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="tnum font-semibold">{naira(isOwing ? left : l.amount)}</p>
                      <p className={`text-xs font-bold ${l.status === 'paid' ? 'text-leaf' : l.status === 'unpaid' ? 'text-clay' : 'text-amber'}`}>
                        {{ paid: 'Paid', part: 'Part paid', unpaid: 'Unpaid', settled_reception: 'At Reception' }[l.status]}
                      </p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          {done.length > 0 && (
            <button onClick={() => setShowDone(s => !s)}
              className="mt-2 w-full h-10 rounded-xl border border-line text-dim text-sm font-semibold">
              {showDone ? 'Hide' : 'Show'} collected items ({done.length}, last 14 days)
            </button>
          )}
        </div>
      )}
    </section>
  )
}
