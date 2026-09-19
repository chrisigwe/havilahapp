import { useEffect, useState } from 'react'
import { naira, lagosToday, methodLabel, friendlyStayError } from '../lib/format'
import { loadFolio, recordStayPayment, checkOutStay } from '../lib/data'
import { useToast } from '../components/Toast'


export default function Folio({ boot, room, onClose, onChanged }) {
  const { staff } = boot
  const payMethods = ['pos', 'cash']   // deliberately fixed, not derived from branch config —
                                        // Rooms payment is POS/Cash only, no Transfer
  const toast = useToast()
  const [data, setData] = useState(null)
  const [pay, setPay] = useState({ amount: '', method: 'pos', split: null })
  const [isOverstay, setIsOverstay] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = () => { loadFolio(room.stay_id).then(setData).catch(() => setData(null)) }
  useEffect(refresh, [room.stay_id])

  if (!data) return (
    <div className="fixed inset-0 z-50 bg-bg p-5">
      <button onClick={onClose} className="text-dim">Close</button>
      <p className="mt-4 text-dim">Loading…</p>
    </div>
  )

  const { orders, payments, folio } = data
  const outstanding = Number(folio?.outstanding ?? 0)
  const live = ['reserved', 'occupied'].includes(room.status) && !!room.stay_id
  // room.status here reflects TODAY's occupancy view — once checked
  // out it no longer appears live on the board, so this component is
  // only ever opened for a currently-live stay; checkout/reopen state
  // is still handled below for completeness if reopened mid-view.
  const orderLines = orders.flatMap(o => (o.order_items || []).map(li => ({ ...li, date: o.business_date })))
  const payParts = pay.split
    ? Object.entries(pay.split).map(([method, amt]) => ({ method, amount: Number(amt || 0) }))
    : [{ method: pay.method, amount: Number(pay.amount || 0) }]
  const payAllocated = payParts.reduce((s, p) => s + p.amount, 0)

  async function submitPayment() {
    if (payAllocated <= 0) return
    setBusy(true)
    try {
      await recordStayPayment({
        staff, stayId: room.stay_id, businessDate: lagosToday(),
        cycle: folio?.billing_cycle, parts: payParts, isOverstay,
      })
      toast('Payment recorded', 'success')
      setPay({ amount: '', method: 'pos', split: null }); setIsOverstay(false)
      refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  async function doCheckOut() {
    setBusy(true)
    try {
      await checkOutStay(room.stay_id, lagosToday())
      toast('Checked out', 'success')
      onChanged?.(); onClose()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="p-5">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">{room.guest_name || 'Guest'}</h2>
        <p className="text-dim mt-1">
          Room {room.room_number} · {room.check_in_date} to {room.scheduled_out}
          {folio?.nights ? ` · ${folio.nights} night${folio.nights > 1 ? 's' : ''}` : ''}
        </p>

        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <Row label="Room charge" value={folio?.room_charge} />
          <Row label="Orders" value={folio?.orders_charge} />
          {Number(folio?.overstay_charge) > 0 && <Row label="Over-stay charge" value={folio?.overstay_charge} />}
          <Row label="Paid" value={folio?.total_paid} />
          <div className="flex items-baseline justify-between pt-3 mt-3 border-t border-line">
            <span className="font-semibold">{outstanding < 0 ? 'Deposit remaining' : 'Outstanding'}</span>
            <span className={`text-xl font-bold tnum ${outstanding > 0 ? 'text-clay' : 'text-leaf'}`}>
              {naira(Math.abs(outstanding))}
            </span>
          </div>
        </div>

        {live && (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim mb-2">Record payment</div>

            <label className="block text-dim text-sm">Amount</label>
            <div className="flex items-center gap-3 mt-1">
              <input type="number" inputMode="decimal" value={pay.amount}
                onChange={e => setPay(p => ({ ...p, amount: e.target.value }))}
                className="h-12 flex-1 px-3 rounded-xl bg-raise border border-line tnum" />
              {outstanding > 0 && (
                <button onClick={() => setPay(p => ({ ...p, amount: String(outstanding) }))}
                  className="text-dim text-sm underline whitespace-nowrap">Full balance</button>
              )}
            </div>

            <label className="block text-dim text-sm mt-3">Paid by</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {payMethods.map(m => (
                <button key={m} onClick={() => setPay(p => ({ ...p, method: m, split: null }))}
                  className={`h-11 px-4 rounded-xl border font-semibold ${!pay.split && pay.method === m
                    ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
                  {methodLabel[m] || m}
                </button>
              ))}
              <button
                onClick={() => setPay(p => ({ ...p,
                  split: p.split || Object.fromEntries(payMethods.map(m => [m, ''])) }))}
                className={`h-11 px-4 rounded-xl border font-semibold ${pay.split
                  ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
                Split
              </button>
            </div>

            {pay.split && (
              <div className="mt-3">
                {Object.keys(pay.split).map(m => (
                  <div key={m} className="flex items-center gap-3 mt-2">
                    <span className="w-20 text-dim">{methodLabel[m] || m}</span>
                    <input type="number" inputMode="decimal" placeholder="0" value={pay.split[m]}
                      onChange={e => setPay(p => ({ ...p, split: { ...p.split, [m]: e.target.value } }))}
                      className="h-11 flex-1 px-3 rounded-xl bg-raise border border-line tnum" />
                  </div>
                ))}
                {(() => {
                  const target = Number(pay.amount) || 0
                  const diff = target - payAllocated
                  if (Math.abs(diff) < 0.01) return <p className="text-dim text-sm mt-2">Splits match the amount.</p>
                  return (
                    <p className="text-clay text-sm mt-2">
                      {diff > 0 ? `${naira(diff)} still unallocated` : `${naira(-diff)} over the amount entered`}
                    </p>
                  )
                })()}
              </div>
            )}

            <label className="flex items-center gap-2 text-dim mt-3">
              <input type="checkbox" checked={isOverstay} onChange={e => setIsOverstay(e.target.checked)} />
              Over-stay payment
            </label>
            <button onClick={submitPayment} disabled={busy || payAllocated <= 0}
              className="mt-3 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
              {busy ? 'Recording…' : `Record ${naira(payAllocated)}`}
            </button>
          </div>
        )}

        {orderLines.length > 0 && (
          <div className="mt-4">
            <div className="text-dim mb-2">Orders</div>
            <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
              {orderLines.map(li => (
                <li key={li.id} className="py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{li.description}</div>
                    <div className="text-dim text-sm">{li.date} · {li.qty} × {naira(li.unit_price)}</div>
                  </div>
                  <span className="tnum font-semibold">{naira(li.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {payments.length > 0 && (
          <div className="mt-4">
            <div className="text-dim mb-2">Payments</div>
            <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
              {payments.map(p => (
                <li key={p.id} className="py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="truncate">
                      {p.method.toUpperCase()}{p.is_overstay ? ' · over-stay' : ''}
                    </div>
                    <div className="text-dim text-sm">{p.business_date}{p.remark ? ` · ${p.remark}` : ''}</div>
                  </div>
                  <span className="tnum font-semibold">{naira(p.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {live && (
          <div className="mt-6">
            {outstanding > 0 && (
              <p className="text-clay text-sm mb-2">{naira(outstanding)} is still outstanding on this room.</p>
            )}
            <button onClick={doCheckOut} disabled={busy}
              className={`w-full h-16 rounded-2xl text-xl font-bold disabled:opacity-40 ${
                outstanding > 0 ? 'bg-clay text-bg' : 'bg-amber text-bg'}`}>
              {outstanding > 0 ? 'Check out with balance owing' : 'Check out'}
            </button>
          </div>
        )}

        {/* Undoing a checkout deliberately has no entry point here — this
            component only ever opens from a Room Board tap, and once a
            stay is checked out the room reverts to vacant in
            v_occupancy_today (stay_id becomes null), so there's nothing
            to tap back into. Reaching an already-checked-out stay needs
            its own search, the same way CheckIn searches for a room and
            RoomChargeSheet searches for a guest — a real follow-up, not
            done here so this screen doesn't look complete when a whole
            path through it can never actually be reached. */}
      </div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-dim">{label}</span>
      <span className="tnum">{naira(value)}</span>
    </div>
  )
}
