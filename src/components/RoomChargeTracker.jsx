import { useEffect, useState } from 'react'
import { loadDepartmentRoomCharges } from '../lib/data'
import { naira, lagosToday, lagosTime } from '../lib/format'

const dShort = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : ''
const daysAgo = d => Math.round((new Date(lagosToday()) - new Date(String(d).slice(0, 10))) / 864e5)

// What a department has charged to rooms, and where the guest's bill stands.
//
// This used to show a paid/unpaid badge on each line. It could not: payments
// attach to the STAY, not the line, so which line a payment settled is not
// recorded anywhere. The old guess counted only money taken at the same
// department's till, which missed every Reception payment and overstated
// Mr Michael Ike's unpaid charges by ₦12,000 on its own (migration 440).
//
// So lines are grouped under the guest, and the money outstanding is the
// guest's folio balance — one figure per guest, counted once, however many
// items they bought. Read-only; payments are recorded on the folio.
//
// mode 'recovered' is the Recovery page's view: lines covered by money taken
// at this department's own till, which IS recorded and so can be shown.
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

  const collectedLines = lines.filter(l => Number(l.paid_amt || 0) > 0)
  const collectedTotal = collectedLines.reduce((s, l) => s + Number(l.paid_amt || 0), 0)

  if (recovered) {
    if (!collectedLines.length) return null
    return (
      <Section title="Room charges recovered" open={open} setOpen={setOpen}
        subtitle={`${collectedLines.length} item${collectedLines.length === 1 ? '' : 's'} on bills now settled, last 60 days`}
        amount={<span className="tnum font-bold text-leaf">{naira(collectedTotal)}</span>}>
        <ul className="divide-y divide-line/60">
          {collectedLines.map(l => (
            <li key={l.id} className="py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-semibold">{l.qty} × {l.item}
                  {!locationId && l.dept && <span className="text-dim font-normal"> · {l.dept}</span>}
                </p>
                <p className="text-dim text-sm">
                  Room {l.room || '—'}{l.guest ? ` · ${l.guest}` : ''} · sold {dShort(l.date)}
                </p>
              </div>
              <p className="tnum font-semibold text-leaf shrink-0">{naira(l.paid_amt)}</p>
            </li>
          ))}
        </ul>
      </Section>
    )
  }

  // One entry per guest, carrying TWO figures that are never mixed:
  //
  //   sold      what THIS department charged to that room — its own money
  //   billLeft  what the guest still owes across everything, as context
  //
  // Showing only billLeft is what produced MainBar's ₦1,500: the Front
  // Desk had cleared Mr Ngoka down to ₦1,500 of room charge and Restaurant
  // food, and MainBar was shown that figure as though it were its own,
  // while the ₦3,000 of water it had actually sold appeared nowhere.
  const byStay = new Map()
  for (const l of lines) {
    if (l.status === 'settled') continue
    const k = l.stay_id
    if (!byStay.has(k)) {
      byStay.set(k, {
        stayId: k, guest: l.guest, room: l.room, status: l.status,
        billLeft: Number(l.bill_left || 0), sold: 0, items: [],
      })
    }
    const g = byStay.get(k)
    g.sold += Number(l.amount || 0)
    g.items.push(l)
  }
  const guests = [...byStay.values()].sort((a, b) =>
    (b.status === 'debt') - (a.status === 'debt') || b.billLeft - a.billLeft)
  const settledLines = lines.filter(l => l.status === 'settled')

  if (!guests.length && !settledLines.length) return null

  // The heading figure is what this department sold and has not been paid
  // for — its own money. Summing billLeft put the room charge and every
  // other department into a bar's total.
  const soldTotal = guests.reduce((s, g) => s + g.sold, 0)
  const gone = guests.filter(g => g.status === 'debt').length

  return (
    <Section title="What you charged to rooms, not yet paid" open={open} setOpen={setOpen}
      subtitle={guests.length
        ? `${guests.length} guest${guests.length === 1 ? '' : 's'}${gone ? ` · ${gone} checked out` : ''}`
        : 'Every guest with room charges has settled'}
      amount={guests.length > 0 && <span className="tnum font-bold text-clay">{naira(soldTotal)}</span>}>

      {!guests.length && !showDone && <p className="text-dim text-sm py-2">Nothing outstanding.</p>}

      <ul className="divide-y divide-line/60">
        {guests.map(g => (
          <li key={g.stayId} className="py-3">
            <div className="flex items-baseline gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">
                  {g.guest || 'Guest'} <span className="text-dim font-normal">· Room {g.room || '—'}</span>
                </p>
                <p className={`text-sm font-semibold ${g.status === 'debt' ? 'text-clay' : 'text-amber'}`}>
                  {g.status === 'debt' ? 'Checked out still owing' : 'In house — bill still running'}
                </p>
                {/* The guest's whole bill, named for what it is so nobody
                    reads it as this department's figure. */}
                <p className="text-dim text-xs">
                  Their whole bill still owes {naira(g.billLeft)}
                </p>
              </div>
              <span className={`tnum font-bold shrink-0 ${g.status === 'debt' ? 'text-clay' : 'text-amber'}`}>
                {naira(g.sold)}
              </span>
            </div>

            <ul className="mt-2 pl-3 border-l border-line">
              {g.items.map(l => {
                const age = daysAgo(l.date)
                return (
                  <li key={l.id} className="py-1 flex items-baseline gap-3 text-sm">
                    <span className="flex-1 min-w-0 text-dim truncate">
                      {l.qty} × {l.item}
                      {!locationId && l.dept && ` · ${l.dept}`}
                      {' · '}{dShort(l.date)}{l.sold_at ? ` ${lagosTime(l.sold_at)}` : ''}
                      {l.sold_by ? ` by ${l.sold_by}` : ''}
                      {age > 2 && <span className="text-clay"> · {age} days ago</span>}
                    </span>
                    <span className="tnum text-dim shrink-0">{naira(l.amount)}</span>
                  </li>
                )
              })}
            </ul>

            {/* Money that physically came through this department's till —
                a till fact, not a settlement. Judging recovery by this is
                what hid every charge the Front Desk collected. */}
            {g.items.some(l => Number(l.till_amt || 0) > 0) && (
              <p className="mt-1 pl-3 text-leaf text-sm">
                {naira(g.items.reduce((s, l) => s + Number(l.till_amt || 0), 0))} of this came through
                {' '}{locationId ? 'this till' : (g.items.find(l => Number(l.till_amt || 0) > 0)?.dept || 'a department till')}.
              </p>
            )}

            <p className="mt-1 pl-3 text-dim text-xs">
              {g.status === 'debt'
                ? 'Collect it on the Credit page.'
                : 'It clears when the guest settles at Reception.'}
            </p>
          </li>
        ))}
      </ul>

      {settledLines.length > 0 && (
        <>
          <button onClick={() => setShowDone(s => !s)}
            className="mt-2 w-full h-10 rounded-xl border border-line text-dim text-sm font-semibold">
            {showDone ? 'Hide' : 'Show'} charges on settled bills ({settledLines.length}, last 14 days)
          </button>
          {showDone && (
            <ul className="mt-2 divide-y divide-line/60">
              {settledLines.map(l => (
                <li key={l.id} className="py-2 flex items-baseline gap-3 text-sm">
                  <span className="flex-1 min-w-0 text-dim truncate">
                    {l.qty} × {l.item} · Room {l.room || '—'}
                    {l.guest ? ` · ${l.guest}` : ''} · {dShort(l.date)}
                  </span>
                  <span className="tnum text-leaf shrink-0">{naira(l.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  )
}

function Section({ title, subtitle, amount, open, setOpen, children }) {
  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">{title}</p>
          <p className="text-dim text-sm">{subtitle}</p>
        </div>
        {amount}
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  )
}
