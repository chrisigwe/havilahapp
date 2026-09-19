import { useEffect, useState } from 'react'
import { naira, lagosToday, methodLabel, cyclesFor, nightsBetween, friendlyStayError } from '../lib/format'
import { loadFolio, loadBranchStaySettings, recordStayPayment, checkOutStay,
         reopenStay, updateStayDetails, updateOverstayFee, deleteStay } from '../lib/data'
import { useToast } from '../components/Toast'

const SUPERVISOR_ROLES = ['manager', 'gm', 'admin']

export default function Folio({ boot, room, onClose, onChanged }) {
  const { staff } = boot
  const payMethods = ['pos', 'cash']   // deliberately fixed, not derived from branch config —
                                        // Rooms payment is POS/Cash only, no Transfer
  const toast = useToast()
  const [data, setData] = useState(null)
  const [branchSettings, setBranchSettings] = useState(null)
  const [pay, setPay] = useState({ amount: '', method: 'pos', split: null })
  const [isOverstay, setIsOverstay] = useState(false)
  const [editing, setEditing] = useState(null)   // { dailyRate, billingCycle, scheduledOut, rateReason } while open
  const [overstayDraft, setOverstayDraft] = useState(null)   // amount string while editing
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = () => { loadFolio(room.stay_id).then(setData).catch(() => setData(null)) }
  useEffect(refresh, [room.stay_id])
  useEffect(() => {
    loadBranchStaySettings(staff.branch_id).then(setBranchSettings).catch(() => setBranchSettings(null))
  }, [staff.branch_id])

  if (!data) return (
    <div className="fixed inset-0 z-50 bg-bg p-5">
      <button onClick={onClose} className="text-dim">Close</button>
      <p className="mt-4 text-dim">Loading…</p>
    </div>
  )

  const { orders, payments, folio, stay } = data
  const outstanding = Number(folio?.outstanding ?? 0)
  const live = ['reserved', 'occupied'].includes(room.status) && !!room.stay_id
  const orderLines = orders.flatMap(o => (o.order_items || []).map(li => ({ ...li, date: o.business_date })))
  const payParts = pay.split
    ? Object.entries(pay.split).map(([method, amt]) => ({ method, amount: Number(amt || 0) }))
    : [{ method: pay.method, amount: Number(pay.amount || 0) }]
  const payAllocated = payParts.reduce((s, p) => s + p.amount, 0)
  const cycles = cyclesFor(branchSettings?.allowedCycles)
  const overstayDefault = branchSettings?.overstayDefault ?? null
  const currentOverstay = stay?.overstay_fee != null ? Number(stay.overstay_fee) : null
  // Setting exactly the branch default is open to anyone (the trigger
  // only restricts a DIFFERENT amount or removing one) — matches
  // enforce_overstay_fee exactly, confirmed against its real body
  // rather than assumed.
  // Matches is_supervisor() exactly (confirmed against its real body):
  // role in ('gm', 'admin') — NOT manager, a narrower set than the
  // manager/gm/admin group that governs undoing an old checkout.
  const canSetNonDefaultOverstay = ['gm', 'admin'].includes(staff.role)

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

  async function doReopen() {
    setBusy(true)
    try {
      await reopenStay(room.stay_id)
      toast('Check-out undone — guest is back in the room', 'success')
      onChanged?.(); onClose()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  async function doDeleteStay() {
    setBusy(true)
    try {
      await deleteStay(room.stay_id)
      toast('Booking deleted', 'success')
      onChanged?.(); onClose()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  function openEdit() {
    setEditing({
      dailyRate: String(folio?.daily_rate ?? ''),
      billingCycle: folio?.billing_cycle || cycles[0]?.value,
      scheduledOut: folio?.scheduled_out || room.scheduled_out,
      rateReason: '',
    })
  }

  async function saveEdit() {
    setBusy(true)
    try {
      await updateStayDetails({
        stayId: room.stay_id, dailyRate: Number(editing.dailyRate),
        billingCycle: editing.billingCycle, scheduledOut: editing.scheduledOut,
        rateReason: editing.rateReason,
      })
      toast('Stay updated', 'success')
      setEditing(null); refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  async function saveOverstay() {
    setBusy(true)
    try {
      await updateOverstayFee(room.stay_id, overstayDraft === '' ? null : Number(overstayDraft))
      toast('Over-stay charge updated', 'success')
      setOverstayDraft(null); refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="p-5">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">{room.guest_name || 'Guest'}</h2>
        <p className="text-dim mt-1">
          Room {room.room_number} · {room.check_in_date} to {folio?.scheduled_out || room.scheduled_out}
          {folio?.nights ? ` · ${folio.nights} night${folio.nights > 1 ? 's' : ''}` : ''}
        </p>
        {live && (
          <button onClick={openEdit} className="text-dim text-sm underline mt-1">
            Edit rate, cycle, or dates
          </button>
        )}
        {['gm', 'admin'].includes(staff.role) && (
          <button onClick={() => setConfirmingDelete(true)} className="block text-clay text-sm underline mt-1">
            Delete this booking — training records only
          </button>
        )}

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
            <div className="flex items-center justify-between">
              <div className="text-dim">Over-stay charge</div>
              {overstayDraft === null && (
                <button onClick={() => setOverstayDraft(currentOverstay != null ? String(currentOverstay) : '')}
                  className="text-dim text-sm underline">
                  {currentOverstay != null ? 'Change' : 'Set'}
                </button>
              )}
            </div>
            {overstayDraft === null ? (
              <p className="tnum mt-1">
                {currentOverstay != null ? naira(currentOverstay)
                  : <span className="text-dim">Not set — branch default is {naira(overstayDefault || 0)}</span>}
              </p>
            ) : (
              <div className="mt-2">
                <input type="number" inputMode="decimal" value={overstayDraft}
                  onChange={e => setOverstayDraft(e.target.value)}
                  placeholder={`Branch default: ${naira(overstayDefault || 0)}`}
                  className="h-12 w-full px-3 rounded-xl bg-raise border border-line tnum placeholder:text-dim" />
                {!canSetNonDefaultOverstay && (
                  <p className="text-dim text-sm mt-1">
                    Only GM or admin can set an amount other than the branch default, or remove it.
                    You can still set it to exactly {naira(overstayDefault || 0)}.
                  </p>
                )}
                <div className="flex gap-3 mt-2">
                  <button onClick={saveOverstay} disabled={busy}
                    className="flex-1 h-11 rounded-xl bg-amber text-bg font-semibold disabled:opacity-40">
                    Save
                  </button>
                  <button onClick={() => setOverstayDraft(null)} className="flex-1 h-11 text-dim">Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

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

        {!live && room.status === 'checked_out' && (() => {
          const closedToday = room.actual_out === lagosToday()
          const canReopen = closedToday || SUPERVISOR_ROLES.includes(staff.role)
          if (!canReopen) return (
            <p className="mt-6 text-dim text-sm">
              Checked out on {room.actual_out}. Only a manager can reopen a stay closed on an earlier day.
            </p>
          )
          return (
            <div className="mt-6">
              <p className="text-dim text-sm mb-2">
                {closedToday ? 'Checked out earlier today.' : `Checked out on ${room.actual_out}.`}
                {outstanding > 0 && ' The balance above is still owing.'}
              </p>
              <button onClick={doReopen} disabled={busy}
                className="w-full h-14 rounded-2xl border border-line text-ink font-semibold disabled:opacity-40">
                Undo check-out — guest is still in the room
              </button>
            </div>
          )
        })()}
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] bg-bg overflow-y-auto p-5">
          <button onClick={() => setEditing(null)} className="text-dim">Back</button>
          <h2 className="mt-3 text-2xl font-bold">Edit rate & dates</h2>

          <label className="block mt-4 text-dim">Daily rate</label>
          <input type="number" inputMode="decimal" value={editing.dailyRate}
            onChange={e => setEditing(x => ({ ...x, dailyRate: e.target.value }))}
            className="mt-1 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          <label className="block mt-4 text-dim">Billing cycle</label>
          <div className="mt-1 flex gap-2">
            {cycles.map(c => (
              <button key={c.value} onClick={() => setEditing(x => ({ ...x, billingCycle: c.value }))}
                className={`flex-1 h-12 rounded-xl border font-semibold ${editing.billingCycle === c.value
                  ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                {c.label}
              </button>
            ))}
          </div>

          <label className="block mt-4 text-dim">Scheduled check-out</label>
          <input type="date" value={editing.scheduledOut} min={room.check_in_date}
            onChange={e => setEditing(x => ({ ...x, scheduledOut: e.target.value }))}
            className="mt-1 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          <label className="block mt-4 text-dim">Reason for the change (optional, but worth noting)</label>
          <input value={editing.rateReason}
            onChange={e => setEditing(x => ({ ...x, rateReason: e.target.value }))}
            className="mt-1 h-14 w-full px-4 rounded-xl bg-surface border border-line" />

          <button onClick={saveEdit} disabled={busy || !editing.dailyRate || !editing.scheduledOut}
            className="mt-6 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}

      {confirmingDelete && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete this booking?</h2>
          <p className="text-dim mt-2">
            {room.guest_name || 'Guest'} · Room {room.room_number}
          </p>
          <p className="text-dim text-sm mt-2">
            Removes the stay along with every room charge and payment attached
            to it. For training records only — this cannot be undone.
          </p>
          <button onClick={doDeleteStay} disabled={busy}
            className="mt-8 w-full h-16 rounded-2xl bg-clay text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Deleting…' : 'Delete booking'}
          </button>
          <button onClick={() => setConfirmingDelete(false)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
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
