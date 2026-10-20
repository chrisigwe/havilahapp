import { useEffect, useState } from 'react'
import { loadDepartmentRoomCharges, recordDepartmentReceipt } from '../lib/data'
import { naira, lagosToday, lagosTime } from '../lib/format'
import Notice from './Notice'
import { useToast } from './Toast'
import { tracked } from '../lib/loadfail'

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
  // Recording what the front desk handed over (564).
  const [receipt, setReceipt] = useState(null)   // { stayId, guest, room, items, owed, pos, cash }
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const toast = useToast()

  useEffect(() => {
    if (!branchId) return
    setLines(null)
    tracked('Money waiting from the front desk', loadDepartmentRoomCharges(branchId, locationId, mode === 'recovered' ? 60 : 14)).then(setLines).catch(() => setLines([]))
  }, [branchId, locationId, refreshKey, tick])

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
  // Money the guest has paid that this department has not been handed
  // yet (564). It is not outstanding — the guest paid — so it must not
  // sit in the list below under "bill still running", which is what it
  // would have read as.
  const waitingByStay = new Map()
  for (const l of lines) {
    if (l.status !== 'with_reception') continue
    const k = l.stay_id
    if (!waitingByStay.has(k)) {
      waitingByStay.set(k, { stayId: k, guest: l.guest, room: l.room, owed: 0, items: [] })
    }
    const w = waitingByStay.get(k)
    const left = Number(l.amount || 0) - Number(l.paid_amt || 0)
    w.owed += left > 0 ? left : 0
    w.items.push(l)
  }
  const waiting = [...waitingByStay.values()].filter(w => w.owed > 0.009)
  const waitingTotal = waiting.reduce((s2, w) => s2 + w.owed, 0)

  const byStay = new Map()
  for (const l of lines) {
    if (l.status === 'settled' || l.status === 'with_reception') continue
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

  // Waiting money counts: a department with nothing outstanding and
  // nothing settled can still be owed a handover, and returning null
  // here would have hidden the one thing it needs to act on.
  if (!guests.length && !settledLines.length && !waiting.length) return null

  // The heading figure is what this department sold and has not been paid
  // for — its own money. Summing billLeft put the room charge and every
  // other department into a bar's total.
  const soldTotal = guests.reduce((s, g) => s + g.sold, 0)
  const gone = guests.filter(g => g.status === 'debt').length

  return (
    <>
    {/* The front desk is holding this department's money. It only
        appears once the guest has actually paid, so there is nothing to
        argue about — the question is only whether the slip and the cash
        have reached this till. */}
    {!!waiting.length && locationId && (
      <Notice tone="warn" className="mt-3"
        title={`${naira(waitingTotal)} paid by guests, not yet recorded here`}>
        {/* Not "waiting from the front desk". v_stay_folio counts every
            payment on the stay wherever it was taken, so some of this
            may be money the department collected at its own till and is
            already holding. Saying it is at Reception would be a false
            statement about where somebody's cash is (20 October 2026). */}
        <p className="mb-3">
          These guests have paid their bill. Record what you were handed by the
          front desk — the printed POS slip and the cash — or what you collected
          here yourself. It then counts as your money for the day, with your
          name on it.
        </p>
        <ul className="divide-y divide-line/40">
          {waiting.map(w => (
            <li key={w.stayId} className="py-2">
              <div className="flex items-baseline gap-3">
                <span className="flex-1 min-w-0">
                  <span className="font-semibold text-ink break-words">{w.guest || 'Guest'}</span>
                  <span className="text-dim"> · Room {w.room || '—'}</span>
                </span>
                <span className="tnum font-bold text-amber shrink-0">{naira(w.owed)}</span>
              </div>
              {w.items.map(l => (
                <div key={l.id} className="text-xs text-dim">
                  {l.qty} × {l.item} · {dShort(l.date)}
                </div>
              ))}
              <button
                onClick={() => setReceipt({ ...w, pos: '', cash: String(w.owed) })}
                className="mt-2 h-10 px-4 rounded-xl border border-amber text-amber text-sm font-semibold">
                Record what I was handed
              </button>
            </li>
          ))}
        </ul>
      </Notice>
    )}

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

    {/* What was handed over, typed by the person holding it. The guest's
        total is filled in as cash, because that is the common case; both
        boxes are there because the slip and the cash are two different
        things and the till has to account for them separately. */}
    {receipt && (
      <div className="fixed inset-0 z-50 bg-bg flex flex-col">
        <div className="p-5 flex-1 overflow-y-auto">
          <button onClick={() => setReceipt(null)} className="text-dim">Back</button>
          <h2 className="mt-3 text-2xl font-bold">Record what you received</h2>
          <p className="text-dim mt-1">
            {receipt.guest || 'Guest'} · Room {receipt.room || '—'}
          </p>

          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim text-sm">This department is owed</div>
            <div className="tnum text-3xl font-bold text-amber">{naira(receipt.owed)}</div>
            <ul className="mt-3 pt-3 border-t border-line space-y-1 text-sm">
              {receipt.items.map(l => (
                <li key={l.id} className="flex justify-between gap-3">
                  <span className="text-dim min-w-0 break-words">{l.qty} × {l.item}</span>
                  <span className="tnum shrink-0">{naira(l.amount)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Each guest's own payments, so the person recording can see
              where the money was taken before typing anything. */}
          {!!receipt.items[0]?.payments?.length && (
            <div className="mt-4 text-sm">
              <p className="text-dim mb-1">How this guest paid</p>
              <ul className="space-y-0.5">
                {receipt.items[0].payments.map((pay, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-dim min-w-0 break-words">
                      {pay.method?.toUpperCase()} at {pay.dept} · {pay.date}
                    </span>
                    <span className="tnum shrink-0">{naira(pay.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="block mt-5 text-dim">On the POS slip</label>
          <input type="number" inputMode="decimal" value={receipt.pos}
            onChange={e => setReceipt(r => ({ ...r, pos: e.target.value }))}
            placeholder="0"
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          <label className="block mt-4 text-dim">Cash in your hand</label>
          <input type="number" inputMode="decimal" value={receipt.cash}
            onChange={e => setReceipt(r => ({ ...r, cash: e.target.value }))}
            placeholder="0"
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          {(() => {
            const typed = (Number(receipt.pos) || 0) + (Number(receipt.cash) || 0)
            const diff = receipt.owed - typed
            return (
              <div className="mt-4 rounded-xl border border-line bg-raise px-4 py-3 space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-dim text-sm">You are recording</span>
                  <span className="tnum font-bold">{naira(typed)}</span>
                </div>
                {Math.abs(diff) > 0.009 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-amber text-sm">
                      {diff > 0 ? 'Still with the front desk after this' : 'More than you are owed'}
                    </span>
                    <span className="tnum text-amber text-sm">{naira(Math.abs(diff))}</span>
                  </div>
                )}
              </div>
            )
          })()}

          <button
            disabled={busy || ((Number(receipt.pos) || 0) + (Number(receipt.cash) || 0)) <= 0}
            onClick={async () => {
              setBusy(true)
              try {
                await recordDepartmentReceipt({
                  stayId: receipt.stayId, locationId,
                  pos: receipt.pos, cash: receipt.cash,
                })
                toast('Recorded — this is your money now', 'success')
                setReceipt(null); setTick(t => t + 1)
              } catch (e) { toast(e.message, 'error') }
              setBusy(false)
            }}
            className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Recording…' : 'Record it'}
          </button>
        </div>
      </div>
    )}
    </>
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
