import { useEffect, useState } from 'react'
import { naira, lagosToday, lagosTime, seesStayTimes, cyclesFor, friendlyStayError } from '../lib/format'
import { billedToLabel, checkOutStay, checkRepeatPayment, deleteOrderItem, deleteStay, loadBranchStaySettings, loadFolio, moveRoomChargeDate, recordStayPayment, setPaymentDepartment, splitPaymentToDepartment, reopenStay, saveRepayment, searchSimilarGuests, setPaymentAllocation, updateOrderItem, updateOverstayFee, updateStayBillTo, updateStayDetails } from '../lib/data'
import { useToast } from '../components/Toast'
import PaymentMethodPicker, { paymentParts, paymentAllocated } from './PaymentMethodPicker'
import FolioStatement from './FolioStatement'
import { MANAGEMENT, SUPERVISOR, is } from '../lib/roles'

// Was named SUPERVISOR_ROLES but has always been manager/gm/admin —
// NOT the gm/admin set that is_supervisor() means.
const SUPERVISOR_ROLES = MANAGEMENT

export default function Folio({ boot, room, onClose, onChanged }) {
  const { staff, allLocations, locations } = boot
  const payMethods = ['pos', 'cash']   // deliberately fixed, not derived from branch config —
                                        // Rooms payment is POS/Cash only, no Transfer
  const toast = useToast()
  const [data, setData] = useState(null)
  const [branchSettings, setBranchSettings] = useState(null)
  // The payment DATE, not just today: a guest who checks in one day and
  // pays the next should have the payment dated when it was taken, so the
  // day's reception figures are right. Defaults to today.
  const [pay, setPay] = useState({ amount: '', method: 'pos', split: null, date: lagosToday() })
  // Correcting the date of a charge already on the folio — GM/admin only
  // (migration 292). Previously impossible: Corrections covers sales and
  // stock movements, not room charges, so every mistake needed SQL.
  const [movingCharge, setMovingCharge] = useState(null)
  const [isOverstay, setIsOverstay] = useState(false)
  // Set when a reopened stay is being checked out again and we have the
  // date it originally left on, so the person can confirm rather than
  // today's date being stamped on silently (migration 459).
  const [checkoutDate, setCheckoutDate] = useState(null)
  // Money that went through ANOTHER department's POS/cash (e.g. a MainBar bill
  // charged to the room, then paid on the bar's terminal). Empty = Reception.
  // Which PART of the bill a payment clears — the room, one department, or
  // (empty, the default) the bill as a whole (migration 496).
  const [allocating, setAllocating] = useState(null)   // payment id whose allocation is being changed
  const [allocDraft, setAllocDraft] = useState('')
  // Which charges the guest is paying for right now (migration 505).
  // Empty = against the whole bill, exactly as every payment behaved
  // before ticking existed.
  const [picked, setPicked] = useState({})
  const [movingPay, setMovingPay] = useState(null)   // { id, loc } while changing an existing payment's department
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

  const { orders, payments, folio, stay, departmentCredit, billedToYou, paidByItem } = data
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
    .map(li => ({ ...li, date: o.business_date, servedBy: o.served_by,
                  orderId: o.id, settlement: o.settlement,
                  approval: o.approval_status || 'approved', decisionNote: o.decision_note })))
  // Which lines the guest is actually BILLED for. This must match
  // v_stay_folio.orders_charge exactly:
  //   settlement = 'charged_to_room' AND order_type <> 'pr_damage'
  // Without both filters the invoice totalled complimentary/damage
  // items and orders already paid for at the department, so it came
  // out higher than the outstanding figure the app showed everywhere
  // else. Non-billable lines are still listed on screen (below), just
  // never added to money.
  // Must match v_stay_folio.orders_charge EXACTLY, which since 248 also
  // requires approval_status = 'approved'. Without this third condition
  // a pending charge would print on the invoice while being absent from
  // its total — the "lines don't add up" bug fixed once already.
  //
  // And STAFF orders. The view excludes both pr_damage AND staff:
  //   oi.order_type <> all (array['pr_damage', 'staff'])
  // This filter only ever excluded pr_damage, so a staff meal charged to
  // a room was listed as a charge on the guest's invoice and counted in
  // the folio's own breakdown, while being absent from the total the
  // app bills. The same bug the comment above was written to prevent,
  // surviving in the line list instead of the total. A staff order is
  // consumed and never billed to the guest, so it belongs with the
  // complimentary lines.
  const isBillable = li => li.settlement === 'charged_to_room'
    && li.order_type !== 'pr_damage' && li.order_type !== 'staff'
    && li.approval === 'approved'
  const billableLines = orderLines.filter(isBillable)
  const freeLines = orderLines.filter(
    li => li.settlement === 'charged_to_room'
       && (li.order_type === 'pr_damage' || li.order_type === 'staff')
       && li.approval === 'approved')
  // Awaiting front desk: shown on screen, never billed until approved.
  const pendingLines = orderLines.filter(
    li => li.settlement === 'charged_to_room' && li.approval === 'pending')
  const payParts = paymentParts(pay, pay.amount)
  const payAllocated = paymentAllocated(pay, pay.amount)

  // ── What the bill is made of, department by department ──────────────
  //
  // One room bill is really several: the room itself, plus whatever each
  // department charged to it. A guest settling the restaurant and leaving
  // the bar for later needs those kept apart (migration 496).
  //
  // The parts are built from the SAME billableLines and folio figures the
  // total already uses, so they cannot drift from it — the "lines don't
  // add up" bug is only ever caused by a second, parallel calculation.
  // Money with no department named is shown on its own rather than being
  // spread across the parts on the guest's behalf.
  //
  // A typed charge carries no location_id (the stock trigger must not
  // fire on a line with no stock item), so those are grouped together and
  // labelled for what they are rather than silently assigned a department.
  // Computed plainly, NOT with useMemo. Everything from here down runs
  // after the `if (!data) return` guard above, so a hook placed here would
  // be called on the loaded render and skipped on the loading one — React
  // throws "rendered more hooks than during the previous render" the moment
  // the folio arrives, which is a blank screen. A few lines and payments
  // cost nothing to add up on every render.
  const locName = (id) => (allLocations || locations || []).find(l => l.id === id)?.name
  const tickedOn = (k) => Number((paidByItem || {})[k] || 0)

  // ── What is actually still unpaid, charge by charge ─────────────────
  //
  // Two kinds of money land on a folio. Money TICKED against a charge
  // settles that charge exactly. Money paid against the bill as a whole
  // — which is most of it, and every payment taken before ticking
  // existed — settles no particular charge, so without a rule it
  // settles none of them: Mr Ngoka had paid ₦184,400 of ₦187,900 and
  // every single line still showed as owing, with the picker offering
  // him the whole bill again.
  //
  // So untagged money covers the bill in the order the guest incurred
  // it: the room first, then charges oldest first. It is stated here
  // once and used by BOTH the breakdown and the picker, so the two can
  // never say different things about the same line.
  const covered = (() => {
    const out = {}
    const roomFull0 = Number(folio?.room_charge || 0) + Number(folio?.overstay_charge || 0)
    // Everything payable on this folio, in the order money should reach it.
    const inOrder = [{ key: 'room', full: roomFull0 }]
      .concat([...billableLines]
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
                     || String(a.id).localeCompare(String(b.id)))
        .map(li => ({ key: li.id, full: Number(li.amount || 0) })))

    // Money with no charge named: everything paid, less what was ticked.
    let pot = Number(folio?.total_paid || 0)
      - Object.values(paidByItem || {}).reduce((t, v) => t + Number(v || 0), 0)

    for (const x of inOrder) {
      const owed = Math.max(0, x.full - tickedOn(x.key))
      const take = Math.max(0, Math.min(pot, owed))
      pot -= take
      out[x.key] = take
    }
    return out
  })()
  // What is left on one charge: its value, less money ticked against it,
  // less its share of the untagged money.
  const stillOwed = (key, full) =>
    Math.max(0, Number(full || 0) - tickedOn(key) - Number(covered[key] || 0))
  const billParts = (() => {
    const roomCharged = Number(folio?.room_charge || 0) + Number(folio?.overstay_charge || 0)
    const byDept = new Map()
    for (const li of billableLines) {
      const key = li.location_id || 'typed'
      const prev = byDept.get(key) || { charged: 0, left: 0 }
      prev.charged += Number(li.amount || 0)
      prev.left += stillOwed(li.id, li.amount)
      byDept.set(key, prev)
    }

    const parts = []
    if (roomCharged > 0) {
      const l = stillOwed('room', roomCharged)
      parts.push({ key: 'room', applied: 'room', locationId: null, name: 'Room charge',
                   charged: roomCharged, paid: roomCharged - l, left: l })
    }
    for (const [key, agg] of byDept) {
      const charged = agg.charged
      const paid = charged - agg.left
      parts.push({
        key,
        applied: key === 'typed' ? null : 'department',
        locationId: key === 'typed' ? null : key,
        // Charges that carry no department: everything typed before this
        // change, plus anything typed at Reception itself, which genuinely
        // belongs to no department. Can't be settled on its own — there is
        // nothing to settle it against — so it is left off the picker and
        // cleared by paying the bill as a whole.
        name: key === 'typed' ? 'Other charges — no department' : (locName(key) || 'A department'),
        charged, paid, left: agg.left,
      })
    }
    // Department credit — a different ledger, offered here all the same.
    // A guest standing at the desk wanting to clear the restaurant does
    // not care which table it lives in, and leaving the desk no way to
    // take that money is how Mr Alphonso's ₦4,500 ended up on his room
    // while his restaurant bill stayed exactly ₦4,500 unpaid.
    //
    // Only offered when we know which account holds it. Without that the
    // line still SHOWS below, it just cannot be paid from here.
    for (const d of (departmentCredit || [])) {
      const bal = Number(d.balance || 0)
      if (bal <= 0.009) continue
      parts.push({
        key: `credit:${d.location_id}`,
        applied: d.customerId ? 'credit' : null,
        locationId: d.location_id,
        customerId: d.customerId || null,
        name: `${d.location_name} — on Credit`,
        charged: bal, paid: 0, left: bal,
        onCredit: true,
      })
    }
    return parts
  })()

  // Money that named what it was for: ticked against specific charges
  // (505), or marked for a department (496). New payments only ever do
  // the first, so the two cannot double-count.
  const earmarked = Object.values(paidByItem || {}).reduce((t, v) => t + Number(v || 0), 0)
    + payments.filter(p => p.applied_to).reduce((t, p) => t + Number(p.amount || 0), 0)
  const generalPaid = Number(folio?.total_paid || 0) - earmarked
  // Only worth showing the split when the bill genuinely has more than one
  // part. A room with no orders on it does not need a breakdown.
  const showParts = billParts.length > 1 || departmentCreditTotal > 0 || billedToYouTotal > 0

  // ── What the guest can pay for, one tickable thing per line ─────────
  //
  // "I'll pay for the two waters" and "just last night's food" are the
  // questions the desk is actually asked, and neither could be answered
  // before: a payment was an amount against a stay and nothing else, so
  // every screen had to guess what it settled. Ticking records it.
  //
  // Each entry carries what is LEFT on it, so a charge already ticked
  // off drops out and a part-paid one shows only the remainder.
  const payables = []
  const roomFull = Number(folio?.room_charge || 0) + Number(folio?.overstay_charge || 0)
  const roomLeft = stillOwed('room', roomFull)
  // The room, night by night. A guest on a long stay settles some nights
  // and leaves the rest, so each unpaid night is its own tickable line
  // rather than the room being one all-or-nothing lump.
  //
  // Nights already covered drop off the top: whatever has been ticked
  // against the room buys whole nights at the stay's own rate, and only
  // what is left is offered. The LAST night carries any remainder — an
  // over-stay fee, or a rate that changed mid-stay — so the night prices
  // always add back up to the room charge exactly.
  const nightRate = Number(folio?.daily_rate || 0)
  const totalNightsOnBill = Number(folio?.nights || 0)
  const nightsCovered = nightRate > 0
    ? Math.floor((tickedOn('room') + Number(covered.room || 0)) / nightRate) : 0
  const nightsToOffer = Math.max(0, totalNightsOnBill - nightsCovered)
  if (roomLeft > 0.009 && nightsToOffer > 1 && nightRate > 0) {
    const inDate = folio?.check_in_date || room.check_in_date
    for (let i = 0; i < nightsToOffer; i++) {
      const n = nightsCovered + i
      const isLast = i === nightsToOffer - 1
      const amt = isLast ? Math.max(0, roomLeft - nightRate * (nightsToOffer - 1)) : nightRate
      if (amt <= 0.009) continue
      const d = inDate ? new Date(new Date(inDate).getTime() + n * 864e5) : null
      payables.push({
        key: `room:${n}`, kind: 'room', orderItemId: null,
        day: 'The room',
        what: `Night ${n + 1}`,
        where: d ? d.toISOString().slice(0, 10) : 'Accommodation',
        amount: Math.round(amt * 100) / 100,
      })
    }
  } else if (roomLeft > 0.009) {
    payables.push({
      key: 'room', kind: 'room', orderItemId: null,
      day: 'The room',
      what: 'Room charge',
      where: totalNightsOnBill
        ? `${totalNightsOnBill} night${totalNightsOnBill > 1 ? 's' : ''} at ${naira(nightRate)}`
        : 'Accommodation',
      amount: roomLeft,
    })
  }
  for (const li of billableLines) {
    const l = stillOwed(li.id, li.amount)
    if (l <= 0.009) continue
    payables.push({
      key: li.id, kind: li.category === 'food' ? 'food' : li.category === 'minimart' ? 'shop' : 'drink',
      orderItemId: li.id,
      day: li.date,
      what: `${li.description}${Number(li.qty) > 1 ? ` × ${li.qty}` : ''}`,
      where: locName(li.location_id) || (li.category === 'food' ? 'Restaurant'
        : li.category === 'minimart' ? 'Minimart' : 'Bar'),
      amount: l,
    })
  }
  // The other ledger. Ticked here, settled there — the desk should not
  // have to know which table a bill lives in.
  for (const d of (departmentCredit || [])) {
    const bal = Number(d.balance || 0)
    if (bal <= 0.009 || !d.customerId) continue
    payables.push({
      key: `credit:${d.location_id}`, kind: 'credit',
      orderItemId: null, customerId: d.customerId, locationId: d.location_id,
      day: 'On credit',
      what: `${d.location_name} account`,
      where: 'Settles on Credit, not on this bill',
      amount: bal,
    })
  }

  // Newest day first, the room always at the top.
  const payDays = []
  for (const p of payables) {
    let g = payDays.find(x => x.day === p.day)
    if (!g) { g = { day: p.day, lines: [] }; payDays.push(g) }
    g.lines.push(p)
  }
  payDays.sort((a, b) => {
    if (a.day === 'The room') return -1
    if (b.day === 'The room') return 1
    if (a.day === 'On credit') return 1
    if (b.day === 'On credit') return -1
    return String(b.day).localeCompare(String(a.day))
  })

  const pickedList = payables.filter(p => picked[p.key])
  const pickedTotal = pickedList.reduce((s, p) => s + p.amount, 0)
  // Ticking fills the amount in. That is the whole point of the screen:
  // the desk is told "the two waters", taps them, and the figure is
  // already right. It stays editable — a guest handing over less than
  // the ticked total is normal, and the money then covers the ticked
  // lines in order.
  const sumOf = (sel) => payables.filter(p => sel[p.key])
    .reduce((s, p) => s + p.amount, 0)
  const applyPick = (next) => {
    setPicked(next)
    const t = sumOf(next)
    setPay(p => ({ ...p, amount: t > 0.009 ? String(Math.round(t * 100) / 100) : '', split: null }))
  }
  const togglePick = (key) => {
    const next = { ...picked }
    if (next[key]) delete next[key]; else next[key] = true
    applyPick(next)
  }
  const pickOnly = (test) => applyPick(
    Object.fromEntries(payables.filter(test).map(p => [p.key, true])))

  // Changing what an existing payment clears is a correction to the
  // record, so it sits with the other corrections: GM and admin.
  const canSetAllocation = is(staff.role, SUPERVISOR) && showParts

  async function saveAllocation(p) {
    const part = billParts.find(x => x.key === allocDraft) || null
    setBusy(true)
    try {
      await setPaymentAllocation(p.id, part?.applied || null, part?.locationId || null)
      toast(part ? `Payment now clears ${part.name}` : 'Payment now clears the whole bill', 'success')
      setAllocating(null); refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }
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
  const canSetNonDefaultOverstay = is(staff.role, SUPERVISOR)
  // Arrival/departure clock times: oversight roles only.
  const showTimes = seesStayTimes(staff.role)

  async function submitPayment() {
    if (payAllocated <= 0) return
    // Taking more than the bill is how money ends up on the wrong folio: the
    // guest's note covers two rooms, or a figure is typed with an extra zero.
    // It is allowed — a deposit against nights still to come is normal — but
    // it is confirmed first, with the numbers in front of the person.
    const owing = Math.round(totalOutstanding * 100) / 100
    if (owing > 0.009 && payAllocated - owing > 0.009 &&
        !window.confirm(`This is ${naira(payAllocated)} against ${naira(owing)} still owing — `
          + `${naira(payAllocated - owing)} more than the bill.\n\n`
          + 'Save it anyway? Tap Cancel if it belongs on another room or another stay.')) {
      return
    }
    if (owing <= 0.009 &&
        !window.confirm(`This bill is already settled. Save ${naira(payAllocated)} on top?\n\n`
          + 'Tap Cancel if the money belongs on another room or another stay.')) {
      return
    }
    // Asked of the database, not the screen — the screen is exactly what
    // is stale when somebody re-enters a payment they could not see land.
    // Skipped when only credit accounts were ticked: that money goes to
    // another table entirely, so this would read the wrong ledger.
    const creditPicks = pickedList.filter(p => p.kind === 'credit')
    const folioPicks = pickedList.filter(p => p.kind !== 'credit')
    const onlyCredit = creditPicks.length > 0 && folioPicks.length === 0

    const repeat = onlyCredit ? null : await checkRepeatPayment(room.stay_id, payAllocated)
    if (repeat && !window.confirm(
          `${naira(repeat.amount)} was already recorded on this bill `
          + `${repeat.minutesAgo} minute${repeat.minutesAgo > 1 ? 's' : ''} ago`
          + `${repeat.who ? ` by ${repeat.who}` : ''}.\n\n`
          + `Is this a second ${naira(payAllocated)} the guest has just paid?\n\n`
          + 'Tap Cancel if it is the same money — it is already saved.')) {
      return
    }
    setBusy(true)
    try {
      // The money covers the ticked lines in the order they are shown,
      // so a part payment lands on the earliest charges rather than
      // being smeared across everything. Whole-line in the ordinary
      // case; the remainder only ever falls on the last line reached.
      let pot = payAllocated
      const creditShare = []
      const itemShare = []
      for (const p of pickedList) {
        if (pot <= 0.009) break
        const take = Math.min(pot, p.amount)
        pot -= take
        if (p.kind === 'credit') creditShare.push({ pick: p, amount: take })
        else itemShare.push({ orderItemId: p.orderItemId, amount: take })
      }
      // Nights are shown separately but settle one pot — the room charge
      // — so they are recorded as one row rather than several identical
      // ones with no order line behind them.
      const roomTotal = itemShare.filter(i => !i.orderItemId)
        .reduce((t, i) => t + i.amount, 0)
      const merged = itemShare.filter(i => i.orderItemId)
      if (roomTotal > 0.009) merged.unshift({ orderItemId: null, amount: Math.round(roomTotal * 100) / 100 })

      // A department's credit lives in credit_repayments against a
      // customer account, not in payments against the stay. Writing it to
      // the stay would clear the wrong debt and leave the real one
      // standing — so it goes to the other ledger, the same way the
      // Credit page does it.
      for (const c of creditShare) {
        await saveRepayment({
          staff, customerId: c.pick.customerId,
          amount: c.amount, method: payParts[0]?.method || 'pos',
          paidOn: pay.date || lagosToday(),
          locationId: c.pick.locationId,
          note: `Taken at Reception, Room ${room.room_number}`,
        })
      }

      // Everything else is a payment on the stay. Ticked lines ride with
      // it so what it settled is recorded rather than inferred later.
      const onFolio = payAllocated - creditShare.reduce((t, c) => t + c.amount, 0)
      if (onFolio > 0.009) {
        const scale = onFolio / payAllocated
        await recordStayPayment({
          staff, stayId: room.stay_id, businessDate: pay.date || lagosToday(),
          cycle: folio?.billing_cycle,
          parts: payParts.map(p => ({ ...p, amount: Number((Number(p.amount) * scale).toFixed(2)) }))
            .filter(p => p.amount > 0),
          // Always Reception: a room bill is settled at the front desk.
          // See the note where the department picker used to be.
          isOverstay, locationId: null,
          items: merged,
        })
      }

      toast(pickedList.length
        ? `Payment recorded against ${pickedList.length} line${pickedList.length === 1 ? '' : 's'}`
        : 'Payment recorded', 'success')
      setPay({ amount: '', method: 'pos', split: null, date: lagosToday() }); setIsOverstay(false)
      setPicked({})
      refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  // Departments that can take a room payment: real sales points of THIS stay's
  // branch, never the store and never Reception itself (that is the default).
  const deptOptions = (allLocations || locations || []).filter(l =>
    l.is_sales_point && !l.is_store && !/reception/i.test(l.name)
    && (!folio?.branch_id || !l.branch_id || l.branch_id === folio.branch_id))

  async function saveMovedPayment() {
    setBusy(true)
    try {
      const part = Number(movingPay.part)
      if (movingPay.loc && movingPay.part !== '' && part > 0 && part < Number(movingPay.total)) {
        await splitPaymentToDepartment(movingPay.id, part, movingPay.loc)
      } else {
        await setPaymentDepartment(movingPay.id, movingPay.loc || null)
      }
      toast('Payment moved', 'success')
      setMovingPay(null); refresh(); onChanged?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  // Checking out used to stamp today, full stop. On a stay that had been
  // reopened to fix a charge, that quietly moved the departure date and
  // charged the nights in between — it caught four stays in two days. If
  // the stay remembers when it really left, ask instead of assuming.
  function doCheckOut() {
    const was = stay?.pre_reopen_actual_out
    if (was && was !== lagosToday()) { setCheckoutDate(was); return }
    finishCheckOut(lagosToday())
  }

  async function finishCheckOut(onDate) {
    setBusy(true)
    try {
      await checkOutStay(room.stay_id, onDate)
      toast('Checked out', 'success')
      setCheckoutDate(null)
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
      // If nothing but "Bill to" changed, save ONLY that. The full save
      // re-sends the rate, cycle and dates, which can fire the
      // rate-adjustment trigger — and linking who a checked-out stay is
      // billed to should never touch the rate. The comparison uses the
      // same expressions openEdit() filled the form with.
      const same = editing.dailyRate === String(folio?.daily_rate ?? '')
        && editing.billingCycle === (folio?.billing_cycle || cycles[0]?.value)
        && editing.scheduledOut === (folio?.scheduled_out || room.scheduled_out)
        && !editing.rateReason
      if (same) {
        await updateStayBillTo({
          stayId: room.stay_id, billTo: editing.billTo.trim(), billToGuestId: editing.billToGuestId,
        })
      } else await updateStayDetails({
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
          Room {room.room_number} · {room.check_in_date}
          {showTimes && stay?.checked_in_at ? ` at ${lagosTime(stay.checked_in_at)}` : ''}
          {' to '}{folio?.scheduled_out || room.scheduled_out}
          {folio?.nights ? ` · ${folio.nights} night${folio.nights > 1 ? 's' : ''}` : ''}
        </p>
        {stay?.bill_to && (
          <p className="mt-2 inline-block px-3 py-1 rounded-full bg-amber/20 border border-amber text-amber text-sm font-semibold">
            Billed to: {stay.bill_to}
          </p>
        )}
        {/* Pre-app history. Every line is still here and nothing has been
            edited, but the figures came across from the Excel workbook and
            are not reliable — so this stay is left out of the live owing
            and overpaid totals rather than being presented as fact. */}
        {stay?.is_migrated && (
          <div className="mt-2 px-3 py-2 rounded-xl bg-raise border border-line">
            <p className="text-ink text-sm font-semibold">From before the app</p>
            <p className="text-dim text-sm mt-1">
              This stay came across from the Excel sheet. Every line is kept
              on the record, but the figures were not entered here and are
              not treated as accurate, so this bill is left out of the
              branch's owing and overpaid totals.
            </p>
          </div>
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
            <p className="text-clay text-sm font-semibold">Rooms billed to this guest:</p>
            {billedToYou.map(b => (
              <p key={b.stay_id} className="text-clay text-sm">
                {b.guest_name} (Room {b.room_number || '—'}){b.check_in_date ? ` · ${b.check_in_date}` : ''}:{' '}
                {billedToLabel(b) || naira(b.outstanding)}
              </p>
            ))}
            {billedToYouTotal > 0 && (
              <p className="text-dim text-xs mt-1">
                Amounts owing are included above. Settle them on that guest's own folio — this
                room's payment doesn't clear them.
              </p>
            )}
          </div>
        )}
        <button onClick={openEdit} className="text-dim text-sm underline mt-1">
          Edit rate, cycle, or dates
        </button>
        <button onClick={() => setPrinting(true)} className="block text-dim text-sm underline mt-1">
          Print guest statement
        </button>
        {is(staff.role, SUPERVISOR) && (
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

        {/* Where the debt sits. The Outstanding figure above counts THREE
            things: this folio, department credit on a linked customer
            account, and other rooms billed to this guest. A breakdown that
            showed only the first would contradict the total sitting right
            above it, so all three are here and the panel ends on the same
            figure. */}
        {showParts && (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <span className="font-semibold">What this bill is made of</span>
            <div className="mt-2">
              {billParts.filter(p => !p.onCredit).map(part => (
                <div key={part.key} className="flex items-baseline justify-between py-1.5">
                  <span className="text-dim">
                    {part.name}
                    {part.paid > 0 && (
                      <span className="block text-xs">{naira(part.paid)} paid against it</span>
                    )}
                  </span>
                  <span className={`tnum font-semibold ${part.left > 0.009 ? 'text-ink'
                    : part.left < -0.009 ? (part.key === 'room' ? 'text-leaf' : 'text-amber') : 'text-leaf'}`}>
                    {/* On the room, money beyond what is owed is nights paid
                        ahead, which is normal for a long stay and should not
                        be dressed up as a fault. On a department it is an
                        overpayment and worth a second look. */}
                    {part.left < -0.009
                      ? (part.key === 'room' ? `${naira(-part.left)} paid ahead` : `${naira(-part.left)} over`)
                      : part.left < 0.009 ? 'Settled' : naira(part.left)}
                  </span>
                </div>
              ))}
            </div>
            {generalPaid > 0.009 && (
              <p className="text-dim text-sm pt-3 mt-1 border-t border-line">
                {naira(generalPaid)} was paid against the bill as a whole rather than
                any one charge, so it has gone to the room first and then the
                oldest charges. Tick charges when taking money to say exactly
                what it pays for.
              </p>
            )}

            {/* A different ledger. These were charged to a customer account
                linked to this guest, not to the room, and they clear through
                Credit — which is why they cannot be picked in Against below. */}
            {departmentCreditTotal > 0 && (
              <div className="pt-3 mt-3 border-t border-line">
                <span className="text-dim text-sm">On Credit — a separate account, payable here</span>
                {billParts.filter(p => p.onCredit).map(part => (
                  <div key={part.key} className="flex items-baseline justify-between py-1.5">
                    <span className="text-clay">
                      {part.name.replace(' — on Credit', '')}
                      {!part.applied && (
                        <span className="block text-xs text-dim">
                          More than one account — settle this on Credit
                        </span>
                      )}
                    </span>
                    <span className="tnum font-semibold text-clay">{naira(part.left)}</span>
                  </div>
                ))}
              </div>
            )}

            {billedToYouTotal > 0 && (
              <div className="pt-3 mt-3 border-t border-line">
                <span className="text-dim text-sm">Other rooms billed to this guest</span>
                {(billedToYou || []).filter(b => Number(b.outstanding) > 0.009).map(b => (
                  <div key={b.stay_id} className="flex items-baseline justify-between py-1.5">
                    <span className="text-clay">
                      {b.guest_name}{b.room_number ? ` · Room ${b.room_number}` : ''}
                    </span>
                    <span className="tnum font-semibold text-clay">{naira(Number(b.outstanding))}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Mirrors the box above word for word. It said "Everything
                outstanding ₦49,500" on a guest who was ₦49,500 AHEAD, which
                reads as a debt he does not have. */}
            <div className="flex items-baseline justify-between pt-3 mt-3 border-t border-line">
              <span className="font-semibold">
                {totalOutstanding < -0.009 ? 'Everything paid ahead' : 'Everything outstanding'}
              </span>
              <span className={`tnum font-bold ${totalOutstanding > 0 ? 'text-clay' : 'text-leaf'}`}>
                {naira(Math.abs(totalOutstanding))}
              </span>
            </div>
          </div>
        )}

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

        {/* A guest who has left can still settle — paying at the desk on
            the way out, or later. Reopening the stay to take money was
            the only route before, which adds a reopen to the record and
            can change the nights charged. Shown after checkout only
            while something is actually owing, so a settled stay stays
            closed. */}
        {(live || (room.status === 'checked_out' && outstanding > 0.009)) && (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim mb-2">
              {live ? 'Record payment' : 'Record a payment after check-out'}
            </div>
            {!live && (
              <p className="text-dim text-sm mb-2">
                Checked out on {room.actual_out}. Recording this settles the balance
                without reopening the stay.
              </p>
            )}

            <label className="block text-dim text-sm">Date paid</label>
            <input type="date" value={pay.date || lagosToday()}
              min={checkIn || undefined} max={lagosToday()}
              onChange={e => setPay(p => ({ ...p, date: e.target.value }))}
              className="mt-1 mb-3 h-12 w-full px-3 rounded-xl bg-raise border border-line tnum" />
            {pay.date && pay.date !== lagosToday() && (
              <p className="text-amber text-sm -mt-2 mb-3">
                Dating this payment {pay.date}. It will count towards that day's
                takings, not today's.
              </p>
            )}

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

            {/* WHAT the guest is paying for. The desk is asked "I'll pay
                for the two waters" or "just last night's food", so this
                asks the same question back rather than making anyone
                translate it into a department. Tick nothing and the money
                goes against the whole bill, exactly as before. */}
            {payables.length > 0 && (
              <div className="mt-4">
                <label className="block font-semibold">What are they paying for?</label>
                <p className="text-dim text-sm mt-0.5">
                  Tap the lines. Leave them all untapped to put the money against
                  the whole bill.
                </p>

                <div className="mt-2 flex gap-2 flex-wrap">
                  {[
                    ['Just the room', p => p.kind === 'room'],
                    ['All the food', p => p.kind === 'food'],
                    ['All the drinks', p => p.kind === 'drink'],
                    ['Everything', () => true],
                  ].map(([label, test]) => (
                    payables.some(test) && (
                      <button key={label} onClick={() => pickOnly(test)}
                        className="h-9 px-3.5 rounded-full bg-raise border border-line text-dim text-sm font-semibold">
                        {label}
                      </button>
                    )
                  ))}
                  {!!pickedList.length && (
                    <button onClick={() => applyPick({})}
                      className="h-9 px-3.5 rounded-full border border-line text-dim text-sm font-semibold">
                      Clear
                    </button>
                  )}
                </div>

                <div className="mt-2 rounded-2xl border border-line bg-surface px-4">
                  {payDays.map(g => (
                    <div key={g.day}>
                      <p className="pt-3 pb-0.5 text-dim text-xs font-bold uppercase tracking-wide">
                        {g.day}
                      </p>
                      {g.lines.map(l => (
                        <label key={l.key}
                          className="py-2.5 flex items-center gap-3 cursor-pointer">
                          <input type="checkbox" checked={!!picked[l.key]}
                            onChange={() => togglePick(l.key)}
                            className="w-6 h-6 shrink-0 accent-amber" />
                          <span className="flex-1 min-w-0">
                            <span className="block font-semibold leading-tight">{l.what}</span>
                            <span className="block text-dim text-xs mt-0.5">{l.where}</span>
                          </span>
                          <span className="tnum font-bold shrink-0">{naira(l.amount)}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>

                {!!pickedList.length && (
                  <p className="mt-2 text-leaf text-sm font-semibold">
                    {pickedList.length} line{pickedList.length === 1 ? '' : 's'} picked
                    {' · '}{naira(pickedTotal)}
                    {payAllocated > 0.009 && pickedTotal - payAllocated > 0.009 && (
                      <span className="block text-amber font-normal mt-0.5">
                        {naira(payAllocated)} received covers {naira(payAllocated)} of it,
                        oldest charge first. The rest stays owing.
                      </span>
                    )}
                    {payAllocated - pickedTotal > 0.009 && (
                      <span className="block text-amber font-normal mt-0.5">
                        {naira(payAllocated)} is more than the {naira(pickedTotal)} picked.
                        The extra goes against the rest of the bill.
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}

            {/* "Paid on a department's POS" used to sit here. Removed: a
                room bill is settled at the front desk, and OpenBar — the
                only department with a terminal of its own — does not serve
                rooms, so there is no department whose drawer the money
                could be in. It was being used to answer "whose charge was
                this?" instead, which tagged front-desk money to MainBar and
                left MainBar's Total Sales expecting POS that was never in
                it. Ticking the charges answers that question properly now.

                The control remains on each recorded payment below, as
                "Change department", so the ones already tagged wrongly can
                be put back to Reception. */}

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

        {/* Awaiting front desk: shown so nobody is surprised at checkout,
            but NOT in the balance above until approved. */}
        {!!pendingLines.length && (
          <div className="mt-4 rounded-2xl border border-amber bg-surface p-4">
            <div className="flex justify-between">
              <span className="font-semibold">Awaiting front-desk approval</span>
              <span className="tnum font-bold">
                {naira(pendingLines.reduce((t, l) => t + Number(l.amount || 0), 0))}
              </span>
            </div>
            <p className="text-dim text-xs mt-1">
              Not on this guest's bill until approved. Approve or refuse it from the
              Reception dashboard.
            </p>
          </div>
        )}

        {orderLines.length > 0 && (
          <div className="mt-4">
            {/* Payment is recorded against the WHOLE stay, not line by
                line, so no single charge can be marked paid. State the
                folio's position instead of implying per-item tracking. */}
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-dim">Orders</span>
              {outstanding > 0.009
                ? <span className="text-clay text-sm font-semibold">
                    {naira(outstanding)} of this bill is unpaid
                  </span>
                : <span className="text-leaf text-sm font-semibold">
                    Bill settled in full
                  </span>}
            </div>
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
                        {li.settlement !== 'charged_to_room' && (
                          <span className="shrink-0 text-xs font-bold text-leaf border border-leaf rounded-full px-2 py-0.5">
                            Paid at dept
                          </span>
                        )}
                        {li.approval === 'pending' && (
                          <span className="shrink-0 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">
                            Awaiting approval
                          </span>
                        )}
                        {li.approval === 'rejected' && (
                          <span className="shrink-0 text-xs font-bold text-clay border border-clay rounded-full px-2 py-0.5">
                            Refused
                          </span>
                        )}
                        {/* Dated wrongly at the till? A GM can move it to
                            the right day without touching the amount. */}
                        {is(staff.role, SUPERVISOR) && (
                          <button
                            onClick={() => setMovingCharge({ id: li.id, date: li.date,
                                                             description: li.description })}
                            className="shrink-0 text-xs text-dim underline">
                            {li.date}
                          </button>
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
                    const canDelete = is(staff.role, SUPERVISOR)
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
                    {p.collected?.name && (
                      <div className="text-amber text-sm">Collected at {p.collected.name}</div>
                    )}
                    {/* What the guest asked this money to clear. Absent on
                        every payment taken before migration 496, and on any
                        the desk left against the bill as a whole. */}
                    {p.applied_to && (
                      <div className="text-leaf text-sm">
                        Clears {p.applied_to === 'room' ? 'the room charge'
                          : locName(p.applied_location_id) || 'a department'}
                      </div>
                    )}
                    {/* Correcting what an older payment was for. Money paid
                        forward for the room should stay against the room
                        instead of being absorbed by a bar tab that turns up
                        later — and before 496 a payment could not say so. */}
                    {canSetAllocation && (
                      allocating === p.id ? (
                        <div className="mt-2">
                          <select value={allocDraft}
                            onChange={e => setAllocDraft(e.target.value)}
                            className="h-11 w-full px-3 rounded-xl bg-raise border border-line">
                            <option value="">The whole bill</option>
                            {billParts.filter(x => x.applied && !x.onCredit).map(x => (
                              <option key={x.key} value={x.key}>{x.name}</option>
                            ))}
                          </select>
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => saveAllocation(p)} disabled={busy}
                              className="h-11 px-4 rounded-xl bg-amber text-bg font-semibold disabled:opacity-40">
                              Save
                            </button>
                            <button onClick={() => setAllocating(null)}
                              className="h-11 px-4 text-dim">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setAllocating(p.id)
                            setAllocDraft(p.applied_to === 'room' ? 'room'
                              : p.applied_to === 'department' ? p.applied_location_id || '' : '')
                          }}
                          className="block text-dim text-xs underline mt-1">
                          {p.applied_to ? 'Change what this clears' : 'Say what this payment was for'}
                        </button>
                      )
                    )}
                    {movingPay?.id === p.id ? (
                      <div className="mt-2">
                        <select value={movingPay.loc}
                          onChange={e => setMovingPay(m => ({ ...m, loc: e.target.value }))}
                          className="h-11 w-full px-3 rounded-xl bg-raise border border-line">
                          <option value="">Reception (this desk)</option>
                          {deptOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                        {movingPay.loc && (
                          <div className="mt-2">
                            <label className="text-dim text-sm">
                              How much of this {naira(p.amount)} was for that department?
                            </label>
                            <input type="number" inputMode="decimal" value={movingPay.part}
                              onChange={e => setMovingPay(m => ({ ...m, part: e.target.value }))}
                              className="mt-1 h-11 w-full px-3 rounded-xl bg-raise border border-line tnum" />
                            {Number(movingPay.part) > 0 && Number(movingPay.part) < Number(p.amount) && (
                              <p className="text-amber text-sm mt-1">
                                {naira(movingPay.part)} goes to that department; {naira(Number(p.amount) - Number(movingPay.part))} stays
                                {p.collected?.name ? ` at ${p.collected.name}` : ' with Reception'}. The guest's total paid does not change.
                              </p>
                            )}
                          </div>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button onClick={saveMovedPayment} disabled={busy}
                            className="flex-1 h-10 rounded-lg bg-amber text-bg font-semibold disabled:opacity-40">Save</button>
                          <button onClick={() => setMovingPay(null)}
                            className="flex-1 h-10 rounded-lg border border-line text-dim">Cancel</button>
                        </div>
                      </div>
                    ) : (deptOptions.length > 0 && (
                      <button onClick={() => setMovingPay({ id: p.id, loc: p.location_id || '', part: String(p.amount), total: p.amount })}
                        className="block text-dim text-xs underline mt-1">Change department</button>
                    ))}
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
            className="mt-1 h-14 px-4 rounded-xl bg-surface border border-line tnum" />

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
        <FolioStatement room={room} folio={folio} orderLines={billableLines}
          freeLines={freeLines} payments={payments} checkedInAt={showTimes ? stay?.checked_in_at : null}
          departmentCredit={departmentCredit} billedToYou={billedToYou}
          allLocations={allLocations || locations}
          branchName={boot.branchName} onClose={() => setPrinting(false)} />
      )}

      {checkoutDate && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Which day did they leave?</h2>
          <p className="text-dim mt-2">
            {room.guest_name || 'Guest'} · Room {room.room_number}
          </p>
          <p className="text-amber text-sm mt-3">
            This stay was reopened. Before that it was checked out on{' '}
            <b>{stay.pre_reopen_actual_out}</b>. Keep that date unless the
            guest really stayed on — a later date charges the nights in
            between.
          </p>

          <label className="block mt-6 text-dim">Departure date</label>
          <input type="date" value={checkoutDate} max={lagosToday()}
            onChange={e => setCheckoutDate(e.target.value)}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

          {checkoutDate !== stay.pre_reopen_actual_out && (
            <p className="text-clay text-sm mt-3">
              Not the date it had before — this will change what the room
              charge comes to.
            </p>
          )}

          <button onClick={() => finishCheckOut(checkoutDate)} disabled={busy || !checkoutDate}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Checking out…' : `Check out on ${checkoutDate}`}
          </button>
          <button onClick={() => setCheckoutDate(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
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

    {/* Folio has no Sheet helper of its own — this matches the
        full-screen overlay its other panels use. */}
    {movingCharge && (
      <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
        <div className="px-5 py-6">
          <button onClick={() => setMovingCharge(null)} className="text-dim">Back</button>
          <h3 className="mt-3 text-2xl font-bold">Move this charge</h3>
          <p className="text-dim text-sm mt-1">{movingCharge.description}</p>

          <label className="block text-dim text-sm mt-5">Date of the charge</label>
          <input type="date" value={movingCharge.date || ''}
            min={checkIn || undefined} max={lagosToday()}
            onChange={e => setMovingCharge(m => ({ ...m, date: e.target.value }))}
            className="mt-1 h-12 w-full px-3 rounded-xl bg-surface border border-line tnum" />
          <p className="text-dim text-sm mt-2">
            Only the day changes. The amount stays the same and the guest's balance
            will not move — if it would, the change is refused.
          </p>

          <button disabled={busy || !movingCharge.date}
            onClick={async () => {
              setBusy(true)
              try {
                await moveRoomChargeDate(movingCharge.id, movingCharge.date)
                toast('Charge moved to ' + movingCharge.date, 'success')
                setMovingCharge(null); refresh(); onChanged?.()
              } catch (e) { toast(e.message, 'error') }
              setBusy(false)
            }}
            className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Moving…' : 'Move it'}
          </button>
          <button onClick={() => setMovingCharge(null)}
            className="mt-2 w-full h-12 text-dim">Cancel</button>
        </div>
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
