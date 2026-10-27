import { createPortal } from 'react-dom'
import { naira, lagosTime } from '../lib/format'
import { billedToLabel } from '../lib/data'
import { guestStatementPdf, savePdf } from '../lib/pdfSheet'

// A guest's printable stay statement — same invoice-print/.invoice-table
// infrastructure Receipt.jsx already uses, not the reference app's
// separate portal-based printing (which it needed only because of its
// own drawer nesting; this app doesn't have that problem).
// A guest reads "20 Oct", not "2026-10-20". The ISO date stays in the
// PDF data and on the printed table, where a date column is expected;
// on screen it is written the way somebody says it out loud.
const niceDay = (d) => {
  if (!d) return ''
  const t = new Date(String(d).slice(0, 10) + 'T12:00:00')
  return isNaN(t) ? String(d)
    : t.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function FolioStatement({ room, folio, orderLines, freeLines, payments, moves = [], branchName, departmentCredit, billedToYou, checkedInAt, allLocations, onClose }) {
  // Which department a line came from, by name. It used to be read off
  // category alone, so every bar printed as "Bar" — a guest querying a
  // drink could not tell MainBar from OpenBar. The line's own department
  // is on the row now; category is only the fallback for older lines.
  const whereFrom = (li) => {
    const id = li?.location_id
    const named = id && (allLocations || []).find(l => l.id === id)?.name
    if (named) return named
    return li?.category === 'food' ? 'Restaurant'
      : li?.category === 'minimart' ? 'Minimart' : 'Bar'
  }
  const roomCharge = Number(folio?.room_charge ?? 0)
  const overstay = Number(folio?.overstay_charge ?? 0)
  // Money comes from v_stay_folio, never from re-summing the line
  // list. The view filters to settlement = 'charged_to_room' AND
  // order_type <> 'pr_damage'; summing raw lines here silently
  // included complimentary/damage items and already-settled orders,
  // so the invoice disagreed with the outstanding figure shown on the
  // Folio, the Credit page and the Reception dashboard. Using the
  // same view those all use makes them agree by construction.
  const orderTotal = Number(folio?.orders_charge ?? 0)
  const totalDue = Number(folio?.total_due ?? 0)
  const paid = Number(folio?.total_paid ?? 0)
  const departmentCreditTotal = (departmentCredit || []).reduce((s, d) => s + Number(d.balance), 0)
  const billedToYouTotal = (billedToYou || []).reduce((s, b) => s + Number(b.outstanding), 0)
  // Per explicit correction, linked department credit and other
  // guests' bills billed to this guest both belong in the headline
  // balance, not just shown separately below it.
  const balance = Number(folio?.outstanding ?? 0) + departmentCreditTotal + billedToYouTotal

  // The PDF is drawn from these same figures rather than from the screen,
  // so it comes out identical on a phone, where the browser cannot print.
  const savePdfFile = () => savePdf(guestStatementPdf({
    branchName,
    ref: String(room.stay_id || '').replace(/-/g, '').slice(0, 8).toUpperCase(),
    guestName: room.guest_name || 'Guest',
    roomNumber: room.room_number,
    stayDates: `${room.check_in_date} to ${folio?.scheduled_out || room.scheduled_out}`,
    nightsText: folio?.nights ? `${folio.nights} night${folio.nights > 1 ? 's' : ''}` : '',
    checkInLabel: `${room.check_in_date}${checkedInAt ? ` ${lagosTime(checkedInAt)}` : ''}`,
    accommodationLabel: `Accommodation — ${room.room_number} · ${folio?.nights} night${folio?.nights > 1 ? 's' : ''} @ ${naira(folio?.daily_rate)}`,
    roomCharge, overstay, orderTotal, totalDue, paid, balance,
    moveLines: (moves || []).filter(mv => Math.abs(Number(mv.adjustment || 0)) > 0.009).map(mv => ({
      date: mv.moved_on,
      label: `Moved to Room ${mv.to_r?.room_number || '?'} from Room ${mv.from_r?.room_number || '?'}`
        + (mv.nights_affected ? ` · ${mv.nights_affected} night${mv.nights_affected === 1 ? '' : 's'}` : ''),
      amount: Number(mv.adjustment),
    })),
    orderLines: (orderLines || []).map(li => ({
      date: li.date, description: li.description, qty: li.qty,
      where: whereFrom(li),
      servedName: li.servedName || '',
      amount: li.amount,
    })),
    freeLines: (freeLines || []).map(li => ({ date: li.date, description: li.description, qty: li.qty, amount: li.amount })),
    payments: (payments || []).map(p => ({ date: p.business_date, method: `${p.method.toUpperCase()}${p.is_overstay ? ' (over-stay)' : ''}`, amount: p.amount })),
    departmentCredit: (departmentCredit || []).map(d => ({ name: d.location_name, balance: d.balance })),
    billedToYou: (billedToYou || []).map(b => ({
      name: `${b.guest_name} (Room ${b.room_number || '-'})${b.check_in_date ? ` · ${b.check_in_date}` : ''}`,
      amount: b.outstanding, label: billedToLabel(b),
    })),
  }), `Statement ${room.guest_name || 'Guest'} room ${room.room_number || ''}`)

  // Rendered into a portal on document.body, not in place. Print CSS
  // can then display:none every OTHER child of body. The previous
  // approach used visibility:hidden, which hides content but leaves it
  // occupying layout height — the app's full scroll height kept
  // generating pages after the invoice, which is where the trailing
  // blank pages came from.
  return createPortal(
    <div className="print-portal fixed inset-0 z-[70] bg-bg h-[100dvh] flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-5 print:hidden">
          <button onClick={onClose} className="text-dim">Back</button>
        </div>

        <div id="folio-statement-area" className="invoice-print px-5 pb-6">
          <div className="invoice-head">
            <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
            <div className="flex items-baseline justify-between">
              <p className="text-dim">{branchName} · Guest Statement</p>
              {/* Derived from the stay id rather than a counter: it is
                  stable across reprints, so two copies of the same
                  statement carry the same reference. */}
              <p className="text-dim text-sm tnum">
                No. {String(room.stay_id || '').replace(/-/g, '').slice(0, 8).toUpperCase()}
              </p>
            </div>
          </div>

          <div className="invoice-meta mt-5">
            <div>
              <div className="text-dim text-sm">Guest</div>
              <div className="text-xl font-bold">{room.guest_name || 'Guest'}</div>
              <div className="text-dim text-sm mt-1">
                Room {room.room_number} · {room.check_in_date} to {folio?.scheduled_out || room.scheduled_out}
                {folio?.nights ? ` · ${folio.nights} night${folio.nights > 1 ? 's' : ''}` : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="text-dim text-sm">Printed</div>
              <div className="tnum">
                {new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos',
                  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>

          {/* THE SAME CHARGES, TWICE (20 October 2026).
              On paper a three-column table is right — it is an invoice,
              and a date column is what people expect. On a phone those
              three columns leave about 90px for the description, so
              "Nsala and garri with beef" became three cramped lines and
              the guest could not read their own bill.

              Phones get the list below; the table prints. Both are
              built from the same orderLines and the same v_stay_folio
              figures, so they cannot differ. */}
          <div className="lg:hidden print:hidden mt-6">
            <h3 className="font-bold mb-2">What you were charged</h3>
            <div className="rounded-2xl border border-line bg-surface px-4">
              <div className="py-3 flex items-baseline gap-3 border-b border-line/60">
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold leading-tight">Accommodation</span>
                  <span className="block text-dim text-xs mt-0.5">
                    Room {room.room_number} · {folio?.nights} night{folio?.nights > 1 ? 's' : ''}
                    {folio?.daily_rate ? ` at ${naira(folio.daily_rate)}` : ''}
                    {' · '}{niceDay(room.check_in_date)}
                  </span>
                </span>
                <span className="tnum font-bold shrink-0">{naira(roomCharge)}</span>
              </div>
              {overstay > 0 && (
                <div className="py-3 flex items-baseline gap-3 border-b border-line/60">
                  <span className="flex-1 min-w-0 font-semibold">Over-stay charge</span>
                  <span className="tnum font-bold shrink-0">{naira(overstay)}</span>
                </div>
              )}
              {/* A room change the guest paid for, or was refunded. It has
                  to be on the bill in words, or the total carries money
                  nothing accounts for (576). */}
              {moves.filter(mv => Math.abs(Number(mv.adjustment || 0)) > 0.009).map(mv => (
                <div key={mv.id} className="py-3 flex items-baseline gap-3 border-b border-line/60">
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold leading-tight break-words">
                      Moved to Room {mv.to_r?.room_number || '?'}
                    </span>
                    <span className="block text-dim text-xs mt-0.5">
                      from Room {mv.from_r?.room_number || '?'} · {niceDay(mv.moved_on)}
                      {mv.nights_affected ? ` · ${mv.nights_affected} night${mv.nights_affected === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                  <span className="tnum font-bold shrink-0">
                    {Number(mv.adjustment) < 0 ? `− ${naira(-Number(mv.adjustment))}` : naira(mv.adjustment)}
                  </span>
                </div>
              ))}
              {orderLines.map(li => (
                <div key={li.id} className="py-3 flex items-baseline gap-3 border-b border-line/60 last:border-0">
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold leading-tight break-words">
                      {li.qty} × {li.description}
                    </span>
                    <span className="block text-dim text-xs mt-0.5">
                      {whereFrom(li)} · {niceDay(li.date)}
                      {/* Who served it (Chris, 25 October 2026). A guest
                          querying a line asks who brought it. */}
                      {li.servedName ? ` · served by ${li.servedName}` : ''}
                    </span>
                  </span>
                  <span className="tnum font-bold shrink-0">{naira(li.amount)}</span>
                </div>
              ))}
            </div>

            {/* The answer first, in the words a guest asks it in. */}
            <div className="mt-3 rounded-2xl border border-line bg-surface p-4 space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-dim">Room and over-stay</span>
                <span className="tnum">{naira(roomCharge + overstay)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-dim">Food, drinks and minimart</span>
                <span className="tnum">{naira(orderTotal)}</span>
              </div>
              <div className="flex justify-between gap-3 pt-2 mt-1 border-t border-line font-bold">
                <span>Total charges</span>
                <span className="tnum">{naira(totalDue)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-dim">Paid</span>
                <span className="tnum text-leaf">{naira(paid)}</span>
              </div>
              <div className="flex justify-between gap-3 pt-2 mt-1 border-t border-line">
                <span className="font-bold">{balance > 0.009 ? 'Balance due' : 'Balance'}</span>
                <span className={`tnum font-bold text-lg ${
                  balance > 0.009 ? 'text-clay' : 'text-leaf'}`}>{naira(Math.abs(balance))}</span>
              </div>
            </div>
          </div>

          <table className="invoice-table mt-6 hidden lg:table print:table">
            <thead><tr><th>Date</th><th>Charges</th><th className="num">Amount</th></tr></thead>
            <tbody>
              <tr>
                <td>{room.check_in_date}{checkedInAt ? ` ${lagosTime(checkedInAt)}` : ''}</td>
                <td>
                  <strong>Accommodation</strong> — Room {room.room_number},
                  {' '}{folio?.nights} night{folio?.nights > 1 ? 's' : ''} at {naira(folio?.daily_rate)} per night
                </td>
                <td className="num tnum">{naira(roomCharge)}</td>
              </tr>
              {overstay > 0 && (
                <tr><td></td><td>Over-stay charge</td><td className="num tnum">{naira(overstay)}</td></tr>
              )}
              {moves.filter(mv => Math.abs(Number(mv.adjustment || 0)) > 0.009).map(mv => (
                <tr key={mv.id}>
                  <td>{mv.moved_on}</td>
                  <td>
                    <strong>Moved to Room {mv.to_r?.room_number || '?'}</strong>
                    {' '}from Room {mv.from_r?.room_number || '?'}
                    <span className="text-dim">
                      {mv.nights_affected ? ` · ${mv.nights_affected} night${mv.nights_affected === 1 ? '' : 's'} × ${naira(Math.abs(Number(mv.rate_difference || 0)))}` : ''}
                    </span>
                  </td>
                  <td className="num tnum">
                    {Number(mv.adjustment) < 0 ? `− ${naira(-Number(mv.adjustment))}` : naira(mv.adjustment)}
                  </td>
                </tr>
              ))}
              {orderLines.map(li => (
                <tr key={li.id}>
                  <td>{li.date}</td>
                  <td>
                    {li.description} <span className="text-dim">× {li.qty}</span>
                    <span className="text-dim">
                      {' · '}{whereFrom(li)}
                      {li.servedName ? ` · served by ${li.servedName}` : ''}
                    </span>
                  </td>
                  <td className="num tnum">{naira(li.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td></td>
                <td className="num">Room and over-stay</td>
                <td className="num tnum">{naira(roomCharge + overstay)}</td>
              </tr>
              <tr>
                <td></td>
                <td className="num">Food, drinks and minimart</td>
                <td className="num tnum">{naira(orderTotal)}</td>
              </tr>
              <tr>
                <td></td>
                <td className="num font-bold">Total charges</td>
                <td className="num tnum font-bold">{naira(totalDue)}</td>
              </tr>
            </tfoot>
          </table>

          {!!freeLines?.length && (
            <>
              <h3 className="mt-6 mb-2 font-bold">Complimentary / not charged</h3>
              <table className="invoice-table print:table">
                <thead><tr><th>Date</th><th>Item</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {freeLines.map(li => (
                    <tr key={li.id}>
                      <td>{li.date}</td>
                      <td>{li.description} <span className="text-dim">× {li.qty}</span></td>
                      <td className="num tnum text-dim">{naira(li.amount)} — no charge</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {payments.length > 0 && (
            <div className="lg:hidden print:hidden mt-6">
              <h3 className="font-bold mb-2">What you paid</h3>
              <div className="rounded-2xl border border-line bg-surface px-4">
                {payments.map(p => (
                  <div key={p.id} className="py-3 flex items-baseline gap-3 border-b border-line/60 last:border-0">
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold">
                        {p.method.toUpperCase()}{p.is_overstay ? ' (over-stay)' : ''}
                      </span>
                      <span className="block text-dim text-xs mt-0.5">{niceDay(p.business_date)}</span>
                    </span>
                    <span className="tnum font-bold text-leaf shrink-0">{naira(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {payments.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 font-bold hidden lg:block print:block">Payments received</h3>
              <table className="invoice-table hidden lg:table print:table">
                <thead><tr><th>Date</th><th>Method</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td>{p.business_date}</td>
                      <td>{p.method.toUpperCase()}{p.is_overstay ? ' (over-stay)' : ''}</td>
                      <td className="num tnum">{naira(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="2" className="num font-bold">Total paid</td>
                    <td className="num tnum font-bold">{naira(paid)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}

          {/* Wrapped rather than hidden directly: .invoice-balance sets
              its own display, so a utility class on the same element is
              a race between two single-class rules. The wrapper has no
              competing rule. */}
          <div className="hidden lg:block print:block">
            <div className="invoice-balance mt-6">
              <span>{balance > 0 ? 'Balance due' : 'Balance'}</span>
              <span className="tnum">{naira(Math.abs(balance))}</span>
            </div>
          </div>

          {!!departmentCredit?.length && (
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid #ccc' }}>
              <p className="font-semibold text-sm">Included above — other departments:</p>
              {departmentCredit.map(d => (
                <div key={d.location_id} className="flex justify-between text-sm mt-1">
                  <span>{d.location_name}</span>
                  <span className="tnum">{naira(d.balance)}</span>
                </div>
              ))}
            </div>
          )}
          {!!billedToYou?.length && (
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid #ccc' }}>
              <p className="font-semibold text-sm">Rooms billed to this guest:</p>
              {billedToYou.map(b => (
                <div key={b.stay_id} className="flex justify-between text-sm mt-1">
                  <span>
                    {b.guest_name} (Room {b.room_number || '—'})
                    {b.check_in_date ? ` · ${b.check_in_date}` : ''}
                  </span>
                  <span className="tnum">{billedToLabel(b) || naira(b.outstanding)}</span>
                </div>
              ))}
              {billedToYouTotal > 0 && (
                <p className="text-dim text-xs mt-1">Amounts owing are included in the balance above.</p>
              )}
            </div>
          )}

          <p className="text-dim text-sm mt-6 invoice-foot">
            Thank you for staying with us.<br />Received by _______________________
          </p>
        </div>
      </div>

      <div className="p-5 border-t border-line flex gap-3 print:hidden">
        <button onClick={onClose} className="flex-1 h-14 rounded-2xl border border-line font-bold">
          Close
        </button>
        <button onClick={savePdfFile}
          className="flex-1 h-14 rounded-2xl bg-amber text-bg font-bold">Save / share PDF</button>
      </div>
    </div>,
    document.body,
  )
}
