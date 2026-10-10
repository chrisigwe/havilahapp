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
// mode 'recovered' is the Recovery page's view of the same lines: only what
// has actually been collected from guests' folios for this department.
export default function RoomChargeTracker({ branchId, locationId = null, refreshKey = 0, mode = 'owing' }) {
  const recovered = mode === 'recovered'
  const [lines, setLines] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const [open, setOpen] = useState(mode === 'recovered')

  useEffect(() => {
    if (!branchId) return
    setLines(null)
    loadDepartmentRoomCharges(branchId, locationId, mode === 'recovered' ? 60 : 14).then(setLines).catch(() => setLines([]))
  }, [branchId, locationId, refreshKey])

  if (!lines) return null
  const owing = lines.filter(l => l.status === 'unpaid' || l.status === 'part')
  const done = lines.filter(l => !(l.status === 'unpaid' || l.status === 'part'))
  const collectedLines = lines.filter(l => Number(l.paid_amt || 0) > 0)
  if (recovered && !collectedLines.length) return null
  if (!recovered && !owing.length && !done.length) return null
  const owedTotal = owing.reduce((s, l) => s + Math.max(0, Number(l.amount) - Number(l.paid_amt || 0)), 0)
  const collectedTotal = collectedLines.reduce((s, l) => s + Number(l.paid_amt || 0), 0)
  const shown = recovered ? collectedLines : showDone ? lines : owing

  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">{recovered ? 'Room charges recovered' : 'Room charges awaiting payment'}</p>
          <p className="text-dim text-sm">
            {recovered
              ? `${collectedLines.length} item${collectedLines.length === 1 ? '' : 's'} collected from guests' bills, last 60 days`
              : owing.length
              ? `${owing.length} item${owing.length === 1 ? '' : 's'} not yet collected`
              : 'Everything charged to rooms has been collected'}
          </p>
        </div>
        {recovered
          ? <span className="tnum font-bold text-leaf">{naira(collectedTotal)}</span>
          : owing.length > 0 && <span className="tnum font-bold text-clay">{naira(owedTotal)}</span>}
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
                      {l.status === 'settled_reception' && (() => {
                        // Only money taken on or after the day this was sold could have paid for it.
                        const since = (l.payments || []).filter(p => String(p.date) >= String(l.date))
                        return (
                          <p className="text-amber text-sm">
                            The guest's bill is settled, but the money was recorded under Reception
                            {since.length ? ` — taken since this was sold: ${since.map(p => `${naira(p.amount)} by ${p.by || 'staff'}, ${dShort(p.date)}`).join('; ')}` : ''}.
                            If any of it was for this item, ask the front desk to move that payment to {l.dept || 'your department'} (Folio → Change department).
                          </p>
                        )
                      })()}
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
          {!recovered && done.length > 0 && (
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
