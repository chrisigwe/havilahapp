import { useEffect, useState } from 'react'
import { naira, lagosToday, cyclesFor, nightsBetween, friendlyStayError } from '../lib/format'
import { loadFolio, loadBranchStaySettings, recordStayPayment, checkOutStay,
         reopenStay, updateStayDetails, updateOverstayFee, deleteStay,
         updateOrderItem, deleteOrderItem, searchSimilarGuests } from '../lib/data'
import { useToast } from '../components/Toast'
import PaymentMethodPicker, { paymentParts, paymentAllocated } from './PaymentMethodPicker'
import FolioStatement from './FolioStatement'

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
  const [billToSuggestions, setBillToSuggestions] = useState([])
  const [billToOpen, setBillToOpen] = useState(false)
  const [overstayDraft, setOverstayDraft] = useState(null)   // amount string while editing
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editingLine, setEditingLine] = useState(null)   // the order line being edited
  const [lineDraft, setLineDraft] = useState(null)
  const [deletingLine, setDeletingLine] = useState(null)  // the order line pending delete confirmation
  const [printing, setPrinting] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = () => { loadFolio(room.stay_id).then(setData).catch(() => setData(null)) }
  useEffect(refresh, [room.stay_id])
  useEffect(() => {
    loadBranchStaySettings(staff.branch_id).then(setBranchSettings).catch(() => setBranchSettings(null))
  }, [staff.branch_id])
  useEffect(() => {
    if (!billToOpen) return
    const t = setTimeout(() => {
      searchSimilarGuests(staff.branch_id, editing?.billTo || '').then(setBillToSuggestions)
    }, 400)
    return () => clearTimeout(t)
  }, [editing?.billTo, staff.branch_id, billToOpen])

  if (!data) return (
    <div className="fixed inset-0 z-50 bg-bg p-5">
      <button onClick={onClose} className="text-dim">Close</button>
      <p className="mt-4 text-dim">Loading…</p>
    </div>
  )

  const { orders, payments, folio, stay, departmentCredit, billedToYou } = data
  const outstanding = Number(folio?.outstanding ?? 0)
  // The room's own balance — used for the pay-button default and
  // checkout logic below, which are genuinely room-specific
  // operations (a room payment can't settle a separate department's
  // credit ledger, so those stay scoped to the room alone).
  const departmentCreditTotal = (departmentCredit || []).reduce((s, d) => s + Number(d.balance), 0)
  const billedToYouTotal = (billedToYou || []).reduce((s, b) => s + Number(b.outstanding), 0)
  // What's actually shown as "Outstanding" — per explicit correction,
  // linked department credit AND other stays billed to this guest
  // both belong in this headline figure, not just displayed
  // separately alongside it.
  const totalOutstanding = outstanding + departmentCreditTotal + billedToYouTotal
  const live = ['reserved', 'occupied'].includes(room.status) && !!room.stay_id

  // Room-rate countdown — how much of the booked period has elapsed
  // vs remains, purely time-based against the planned nights. This is
  // deliberately independent of payment/outstanding: an advance that
  // exactly matches the room rate for the period gets fully "used up"
  // by the last night regardless of what's been charged to other
  // departments in the meantime (see Alphonso — his room rate is fully
  // covered even though his overall balance owes money for extras).
  const totalNights = Number(folio?.nights ?? 0)
  const dailyRate = Number(folio?.daily_rate ?? 0)
  const checkIn = folio?.check_in_date || room.check_in_date
  const scheduledOut = folio?.scheduled_out || room.scheduled_out
  const rawNightsElapsed = checkIn
    ? Math.round((new Date(lagosToday()) - new Date(checkIn)) / 864e5) : 0
  const nightsElapsed = Math.max(0, Math.min(totalNights, rawNightsElapsed))
  const nightsLeft = Math.max(0, totalNights - nightsElapsed)
  const consumedRoomCharge = nightsElapsed * dailyRate
  const remainingRoomCharge = Math.max(0, Number(folio?.room_charge ?? 0) - consumedRoomCharge)
  const pctElapsed = totalNights > 0 ? Math.min(100, Math.round((nightsElapsed / totalNights) * 100)) : 0
  const showCountdown = room.status === 'occupied' && totalNights > 1

  const orderLines = orders.flatMap(o => (o.order_items || [])
    .map(li => ({ ...li, date: o.business_date, servedBy: o.served_by, orderId: o.id })))
  const payParts = paymentParts(pay, pay.amount)
  const payAllocated = paymentAllocated(pay, pay.amount)
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

  function openEditLine(li) {
    setEditingLine(li)
    setLineDraft({ description: li.description, qty: String(li.qty), unitPrice: String(li.unit_price) })
  }

  async function saveEditLine() {
    setBusy(true)
    try {
      await updateOrderItem(editingLine.id, {
        description: lineDraft.description, qty: Number(lineDraft.qty), unit_price: Number(lineDraft.unitPrice),
      })
      toast('Order updated', 'success')
      setEditingLine(null); refresh(); onChanged?.()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function doDeleteLine() {
    setBusy(true)
    try {
      await deleteOrderItem(deletingLine.id, deletingLine.orderId)
      toast('Order removed', 'success')
      setDeletingLine(null); refresh(); onChanged?.()
    } catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setBusy(false)
  }

  function openEdit() {
    setEditing({
      dailyRate: String(folio?.daily_rate ?? ''),
      billingCycle: folio?.billing_cycle || cycles[0]?.value,
      scheduledOut: folio?.scheduled_out || room.scheduled_out,
      rateReason: '', billTo: stay?.bill_to || '', billToGuestId: stay?.bill_to_guest_id || null,
    })
  }

  async function saveEdit() {
    setBusy(true)
    try {
      await updateStayDetails({
        stayId: room.stay_id, dailyRate: Number(editing.dailyRate),
        billingCycle: editing.billingCycle, scheduledOut: editing.scheduledOut,
        rateReason: editing.rateReason, billTo: editing.billTo.trim(), billToGuestId: editing.billToGuestId,
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
        {stay?.bill_to && (
          <p className="mt-2 inline-block px-3 py-1 rounded-full bg-amber/20 border border-amber text-amber text-sm font-semibold">
            Billed to: {stay.bill_to}
          </p>
        )}
        {!!departmentCredit?.length && (
          <div className="mt-2 px-3 py-2 rounded-xl bg-clay/10 border border-clay">
            <p className="text-clay text-sm font-semibold">Included above — other departments:</p>
            {departmentCredit.map(d => (
              <p key={d.location_id} className="text-clay text-sm">
                {d.location_name}: {naira(d.balance)}
              </p>
            ))}
            <p className="text-dim text-xs mt-1">
              Settled separately on Credit — paying the room balance doesn't clear this.
            </p>
          </div>
        )}
        {!!billedToYou?.length && (
          <div className="mt-2 px-3 py-2 rounded-xl bg-clay/10 border border-clay">
            <p className="text-clay text-sm font-semibold">Included above — other bills:</p>
            {billedToYou.map(b => (
              <p key={b.stay_id} className="text-clay text-sm">
                {b.guest_name} (Room {b.room_number || '—'}): {naira(b.outstanding)}
              </p>
            ))}
            <p className="text-dim text-xs mt-1">
              Settle these on that guest's own folio — this room's payment doesn't clear them.
            </p>
          </div>
        )}
        <button onClick={openEdit} className="text-dim text-sm underline mt-1">
          Edit rate, cycle, or dates
        </button>
        <button onClick={() => setPrinting(true)} className="block text-dim text-sm underline mt-1">
          Print guest statement
        </button>
        {['gm', 'admin'].includes(staff.role) && (
          <button onClick={() => setConfirmingDelete(true)} className="block text-clay text-sm underline mt-1">
            Delete this booking — training records only
          </button>
        )}

        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <Row label="Room charge" value={folio?.room_charge} />
          <Row label="Orders" value={folio?.orders_charge} />
          {Number(folio?.overstay_charge) > 0 && <Row label="Over-stay charge" value={folio?.overstay_charge} />}
          {departmentCreditTotal > 0 && <Row label="Other departments" value={departmentCreditTotal} />}
          {billedToYouTotal > 0 && <Row label="Other bills (billed to you)" value={billedToYouTotal} />}
          <Row label="Paid" value={folio?.total_paid} />
          <div className="flex items-baseline justify-between pt-3 mt-3 border-t border-line">
            <span className="font-semibold">{totalOutstanding < 0 ? 'Deposit remaining' : 'Outstanding'}</span>
            <span className={`text-xl font-bold tnum ${totalOutstanding > 0 ? 'text-clay' : 'text-leaf'}`}>
              {naira(Math.abs(totalOutstanding))}
            </span>
          </div>
        </div>

        {showCountdown && (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-semibold">Room rate — period progress</span>
              <span className="text-dim text-sm">{scheduledOut}</span>
            </div>
            <div className="h-2.5 rounded-full bg-line overflow-hidden">
              <div className="h-full bg-clay" style={{ width: `${pctElapsed}%` }} />
            </div>
            <div className="flex justify-between text-sm mt-2">
              <span className="text-dim">
                {nightsElapsed} of {totalNights} night{totalNights > 1 ? 's' : ''} used
              </span>
              <span className="text-dim">{nightsLeft} left</span>
            </div>
            <div className="flex justify-between mt-3 pt-3 border-t border-line">
              <div>
                <div className="text-dim text-sm">Taken out so far</div>
                <div className="tnum font-bold">{naira(consumedRoomCharge)}</div>
              </div>
              <div className="text-right">
                <div className="text-dim text-sm">Left in the room rate</div>
                <div className="tnum font-bold text-leaf">{naira(remainingRoomCharge)}</div>
              </div>
            </div>
          </div>
        )}


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
            <div className="mt-1">
              <PaymentMethodPicker methods={payMethods} amount={pay.amount}
                value={pay} onChange={v => setPay(p => ({ ...p, ...v }))} />
            </div>

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
                <li key={li.id} className="py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="truncate flex items-center gap-2">
                        <span className="truncate">{li.description}</span>
                        {li.order_type === 'pr_damage' && (
                          <span className="shrink-0 text-xs font-bold text-clay border border-clay rounded-full px-2 py-0.5">
                            PR / Damage
                          </span>
                        )}
                        {li.order_type === 'staff' && (
                          <span className="shrink-0 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">
                            Staff
                          </span>
                        )}
                      </div>
                      <div className="text-dim text-sm">
                        {li.date} · {li.qty} × {naira(li.unit_price)}
                        {li.order_type === 'pr_damage' && ' · not charged to guest'}
                        {(li.damage_reason || li.pr_meal) && ` · ${li.damage_reason || li.pr_meal}`}
                        {li.writeoff_note && ` · ${li.writeoff_note}`}
                      </div>
                    </div>
                    <span className="tnum font-semibold">{naira(li.amount)}</span>
                  </div>
                  {(() => {
                    const canDelete = ['gm', 'admin'].includes(staff.role)
                    const canEdit = canDelete || li.servedBy === staff.id
                    if (!canEdit) return null
                    return (
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => openEditLine(li)}
                          className="h-9 px-3 rounded-lg border border-line text-sm font-semibold">
                          Edit
                        </button>
                        {canDelete && (
                          <button onClick={() => setDeletingLine(li)}
                            className="h-9 px-3 rounded-lg border border-clay text-clay text-sm font-semibold">
                            Delete
                          </button>
                        )}
                      </div>
                    )
                  })()}
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

          <label className="block mt-4 text-dim">Billed to (optional)</label>
          <input value={editing.billTo}
            onChange={e => { setEditing(x => ({ ...x, billTo: e.target.value, billToGuestId: null })); setBillToOpen(true) }}
            onFocus={() => setBillToOpen(true)}
            placeholder="Leave blank if the guest pays their own bill"
            className="mt-1 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
          {billToOpen && !!billToSuggestions.length && (
            <div className="mt-2 rounded-xl border border-amber bg-surface divide-y divide-line overflow-hidden">
              <div className="px-4 py-2 text-dim text-sm">Is this an existing guest?</div>
              {billToSuggestions.map(g => (
                <button key={g.id} type="button"
                  onClick={() => {
                    setEditing(x => ({ ...x, billTo: g.full_name, billToGuestId: g.id }))
                    setBillToOpen(false); setBillToSuggestions([])
                  }}
                  className="block w-full text-left px-4 py-3 hover:bg-raise">
                  <div className="font-semibold">{g.full_name}</div>
                  {g.phone && <div className="text-dim text-sm">{g.phone}</div>}
                </button>
              ))}
              <button type="button" onClick={() => { setBillToOpen(false); setBillToSuggestions([]) }}
                className="block w-full text-center px-4 py-2 text-dim text-sm">
                No — not a guest
              </button>
            </div>
          )}
          {editing.billToGuestId && (
            <p className="text-dim text-xs mt-1">Linked — this amount will also show on their own folio.</p>
          )}

          <button onClick={saveEdit} disabled={busy || !editing.dailyRate || !editing.scheduledOut}
            className="mt-6 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}

      {printing && (
        <FolioStatement room={room} folio={folio} orderLines={orderLines} payments={payments}
          departmentCredit={departmentCredit} billedToYou={billedToYou}
          branchName={boot.branchName} onClose={() => setPrinting(false)} />
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

      {editingLine && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Edit this order</h2>

          <label className="block mt-6 text-dim">Description</label>
          <input value={lineDraft.description}
            onChange={e => setLineDraft(d => ({ ...d, description: e.target.value }))}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line" />

          <label className="block mt-4 text-dim">Quantity</label>
          <input type="number" inputMode="decimal" value={lineDraft.qty}
            onChange={e => setLineDraft(d => ({ ...d, qty: e.target.value }))}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          <label className="block mt-4 text-dim">Unit price</label>
          <input type="number" inputMode="decimal" value={lineDraft.unitPrice}
            onChange={e => setLineDraft(d => ({ ...d, unitPrice: e.target.value }))}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          <button onClick={saveEditLine} disabled={busy || !lineDraft.description.trim() || !lineDraft.qty}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={() => setEditingLine(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}

      {deletingLine && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete this order?</h2>
          <p className="text-dim mt-2">
            {deletingLine.description} — {deletingLine.qty} × {naira(deletingLine.unit_price)}
          </p>
          <p className="text-dim text-sm mt-2">
            Removes this charge from the guest's bill and reverses any stock it
            deducted. This cannot be undone.
          </p>
          <button onClick={doDeleteLine} disabled={busy}
            className="mt-8 w-full h-16 rounded-2xl bg-clay text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Deleting…' : 'Delete order'}
          </button>
          <button onClick={() => setDeletingLine(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
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
