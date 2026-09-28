import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { lagosToday, methodLabel, naira, startingDept, tierLabel } from '../lib/format'
import { loadBalances, loadCustomerLedger, saveRepayment, loadStaffForLocation,
         deleteCustomer, deactivateCustomer, loadGuestBalances, recordStayPayment, loadFolio,
         linkCustomerToGuest, searchSimilarGuests, moveWorkaroundToRoom,
         loadUnlinkedCustomerBalances, loadCreditOnDate } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import PaymentMethodPicker, { paymentParts, paymentAllocated } from '../components/PaymentMethodPicker'
import FolioStatement from '../components/FolioStatement'
import { EDITOR, OVERSIGHT, SUPERVISOR, is } from '../lib/roles'

function printStatement() {
  document.querySelectorAll('.invoice-print').forEach(el => {
    el.style.display = el.id === 'statement-area' ? '' : 'none'
  })
  window.print()
  document.querySelectorAll('.invoice-print').forEach(el => { el.style.display = '' })
}

export default function Credit({ boot }) {
  const { staff, items, methods, allLocations, locations } = boot
  const isEditor = is(staff.role, EDITOR)
  const isAdmin = is(staff.role, SUPERVISOR)
  // Specifically excluded from crediting a repayment to anyone else —
  // any repayment they record is attributed to themselves regardless
  // of whose balance the customer is on. Pinned to their staff id so
  // a role change doesn't quietly reopen it, and matched by an
  // equivalent database trigger (72_awka_storekeeper_no_on_behalf.sql)
  // so this can't be worked around by hand-editing the request.
  const NO_ON_BEHALF = new Set(['a5ea88b6-80e7-4776-a491-78a509e589c6'])
  // department chips must show EVERY department for management/audit
  // roles, explicitly — not by relying on boot.locations happening to
  // equal allLocations when nobody has assigned that person to a
  // single department. An auditor accidentally given a staff_locations
  // row would otherwise silently lose visibility with no error.
  const seesAllDepartments = is(staff.role, OVERSIGHT)  // same as Recovery and Sales
  const salesPoints = (seesAllDepartments ? allLocations : locations || [])
    .filter(l => l.is_sales_point && !l.is_store)
  // Whether this person can see guest-level, cross-department debt at
  // all — a role/assignment fact, not "which chip happens to be
  // selected right now". Guest balances (loadGuestBalances) already
  // aggregate every department for a linked guest; gating it on the
  // currently-selected chip instead of on actual Reception access
  // meant a front-desk person with Reception in their own location
  // list — Daniel, specifically — could still miss a guest's debt at
  // a department like MainBar just by having a different chip
  // selected when they looked.
  const hasReceptionAccess = seesAllDepartments || (locations || []).some(l => /reception/i.test(l.name))
  const [locId, setLocId] = useState(startingDept(salesPoints, staff, locations))
  // Re-sync the selected department when the GM switches branch — the
  // old branch's location id matches no chip here, so without this
  // nothing highlights until a manual tap.
  useEffect(() => {
    const valid = salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(startingDept(salesPoints, staff, locations))
  }, [staff.branch_id])
  const [confirmDel, setConfirmDel] = useState(null)
  const [delBusy, setDelBusy] = useState(false)
  const [people, setPeople] = useState([])
  const [staffFilter, setStaffFilter] = useState(null)   // null = everyone
  // tracked synchronously so an in-flight response can check, when it
  // arrives, whether it's still answering the CURRENT question — a
  // ref rather than state, since it must be read inside an async
  // callback without being subject to closure staleness itself.
  // Widened from just locId to a combined key including staffFilter,
  // because switching departments can trigger the staff filter to
  // auto-clear (its previously-selected person doesn't work in the
  // new department), which fires a SECOND refresh — and the first
  // response's location was still correct when it arrived, so the
  // narrower guard let it through despite carrying the wrong filter.
  const requestKey = `${locId}|${isEditor ? (staffFilter || 'everyone') : 'na'}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const [rows, setRows] = useState(null)
  const [guestBalances, setGuestBalances] = useState(null)
  const [guestPay, setGuestPay] = useState(null)   // { stayId, guestName, roomNumber, outstanding, billingCycle, amount, method, split, isOverstay }
  const [guestStatement, setGuestStatement] = useState(null)   // { room, folio, orderLines, payments } once loaded
  const [statementBusy, setStatementBusy] = useState(false)
  const toast = useToast()
  const [open, setOpen] = useState(null)       // { customer, ledger }
  const [linking, setLinking] = useState(false)
  // The customer being linked. Previously the link sheet read
  // open.customer directly, so it could only be reached from inside
  // a statement — unreachable from Reception, which has no customer
  // list at all.
  const [linkTarget, setLinkTarget] = useState(null)
  const [unlinked, setUnlinked] = useState(null)
  // Empty = the normal running-balance view. A date switches to
  // that day's activity instead; the two answer different
  // questions and showing them together would be confusing.
  const [dayFilter, setDayFilter] = useState('')
  const [dayData, setDayData] = useState(null)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState([])
  const [linkBusy, setLinkBusy] = useState(false)
  const [movingToRoom, setMovingToRoom] = useState(null)   // { customerId, locationId, amount }
  const [moveBusy, setMoveBusy] = useState(false)
  const [pay, setPay] = useState(null)
  const [busy, setBusy] = useState(false)
  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries((allLocations || []).map(l => [l.id, l])), [allLocations])
  const isReception = /reception/i.test(locById[locId]?.name || '')

  const refresh = useCallback(() => {
    const requestedFor = requestKey   // snapshot at the moment this fetch was started
    loadBalances(staff.branch_id, locId, isEditor ? staffFilter : null)
      .then(data => { if (requestKeyRef.current === requestedFor) setRows(data) })
      .catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId, staffFilter, isEditor, requestKey])
  useEffect(refresh, [refresh])

  // Reception's guest balances — a different data model entirely, so
  // a separate load rather than folded into the customer refresh above.
  const refreshGuestBalances = useCallback(() => {
    if (!hasReceptionAccess) return
    loadGuestBalances(staff.branch_id, isEditor ? staffFilter : null)
      .then(setGuestBalances).catch(() => setGuestBalances([]))
  }, [staff.branch_id, hasReceptionAccess, isEditor, staffFilter])
  useEffect(refreshGuestBalances, [refreshGuestBalances])

  // Load the department-scoped staff list once per department change,
  // NOT on every refresh — because the auto-clear inside would also
  // reset staffFilter every time the user picks a filter chip, then
  // immediately drop the (correct) response as stale. This was the
  // real reason clicking a person still returned every debtor.
  useEffect(() => {
    if (!isEditor || !locId) return
    loadStaffForLocation(staff.branch_id, locId).then(ps => {
      setPeople(ps)
      setStaffFilter(cur => ps.some(p => p.id === cur) ? cur : null)
    })
  }, [staff.branch_id, locId, isEditor])

  async function openCustomer(c) {
    try {
      const ledger = await loadCustomerLedger(staff.branch_id, c.customer_id, locId,
        isEditor ? (c.staff_id || null) : null)
      setOpen({ customer: c, ledger })
    } catch (e) { toast(e.message, 'error') }
  }

  useEffect(() => {
    if (!linking) return
    const t = setTimeout(() => {
      searchSimilarGuests(staff.branch_id, linkQuery).then(setLinkResults)
    }, 350)
    return () => clearTimeout(t)
  }, [linkQuery, linking, staff.branch_id])

  const refreshUnlinked = useCallback(() => {
    if (!hasReceptionAccess) return
    loadUnlinkedCustomerBalances(staff.branch_id).then(setUnlinked).catch(() => setUnlinked([]))
  }, [hasReceptionAccess, staff.branch_id])
  useEffect(refreshUnlinked, [refreshUnlinked])

  useEffect(() => {
    if (!dayFilter) { setDayData(null); return }
    setDayData(null)
    loadCreditOnDate(staff.branch_id, dayFilter, locId === 'all' ? null : locId)
      .then(setDayData).catch(e => toast(e.message, 'error'))
  }, [dayFilter, staff.branch_id, locId, toast])

  async function confirmLink(guest) {
    setLinkBusy(true)
    try {
      await linkCustomerToGuest(linkTarget.customerId, guest.id)
      toast(`Linked to ${guest.full_name}`, 'success')
      setLinking(false); setLinkTarget(null); setLinkQuery(''); setLinkResults([])
      refreshUnlinked()
    } catch (e) { toast(e.message, 'error') }
    setLinkBusy(false)
  }

  async function confirmMoveToRoom() {
    setMoveBusy(true)
    try {
      await moveWorkaroundToRoom(movingToRoom.customerId, movingToRoom.locationId)
      toast('Moved to room charge', 'success')
      setMovingToRoom(null); setOpen(null); refresh()
    } catch (e) { toast(e.message, 'error') }
    setMoveBusy(false)
  }

  async function submitPayment() {
    setBusy(true)
    const base = {
      staffLite: { id: staff.id, branch_id: staff.branch_id },
      customerId: pay.customerId, paidOn: pay.paidOn, note: pay.note,
      locationId: pay.locationId, creditStaffId: pay.creditStaffId,
    }
    // Split: no schema change needed — credit_repayments is already
    // one row per method, same as it's always been for a single
    // payment. "Split" just means saving more than one row for the
    // same repayment, one per method with a non-zero amount.
    const parts = paymentParts(pay, pay.amount).filter(p => p.amount > 0)
    try {
      for (const part of parts) {
        const args = { ...base, amount: part.amount, method: part.method }
        try {
          await saveRepayment({ ...args, staff })
        } catch (e) {
          if (!isConnectionError(e)) throw e
          enqueue({ kind: 'repayment', payload: args })
        }
      }
      toast('Payment recorded', 'success')
      flush()
      setPay(null); setOpen(null); refresh()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function submitGuestPayment() {
    setBusy(true)
    try {
      await recordStayPayment({
        staff, stayId: guestPay.stayId, businessDate: lagosToday(),
        cycle: guestPay.billingCycle, parts: paymentParts(guestPay, guestPay.amount),
        isOverstay: guestPay.isOverstay,
      })
      toast('Payment recorded', 'success')
      setGuestPay(null); refreshGuestBalances()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  // guestPay only carries what the payment form needs (outstanding,
  // billing cycle) — the full charge/payment breakdown a printed
  // statement needs lives in loadFolio, the same function Folio.jsx
  // already uses, so this fetches it fresh rather than duplicate
  // that query's shape here.
  async function printGuestStatement() {
    setStatementBusy(true)
    try {
      const { orders, payments, folio, departmentCredit, billedToYou } = await loadFolio(guestPay.stayId)
      const orderLines = orders.flatMap(o => (o.order_items || []).map(li => ({ ...li, date: o.business_date })))
      setGuestStatement({
        room: { room_number: guestPay.roomNumber, guest_name: guestPay.guestName,
                check_in_date: folio?.check_in_date, scheduled_out: folio?.scheduled_out },
        folio, orderLines, payments, departmentCredit, billedToYou,
      })
    } catch (e) { toast('Could not load statement: ' + e.message, 'error') }
    setStatementBusy(false)
  }

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  // Final safety net against any stale-response race: never show a row
  // whose location doesn't match the selected department, and (when a
  // staff filter is active) whose booker doesn't match it either. Even
  // if a late/out-of-order fetch lands in `rows`, it physically cannot
  // paint under the wrong department — the filter is on the data
  // itself, not on a timing guard that can drift.
  const owing = rows.filter(r =>
    Number(r.balance) > 0.009
    && (!locId || r.location_id === locId)
    && (!staffFilter || r.staff_id === staffFilter))
  const total = owing.reduce((s, r) => s + Number(r.balance), 0)

  return (
    <div className="px-5">
      {salesPoints.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
          {salesPoints.map(l => (
            <button key={l.id} onClick={() => setLocId(l.id)}
              className={`shrink-0 h-11 px-4 rounded-full border ${l.id === locId
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}

      {isEditor && people.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-1 -mx-1 px-1">
          <button onClick={() => setStaffFilter(null)}
            className={`shrink-0 h-10 px-3 rounded-full border text-sm ${!staffFilter
              ? 'bg-raise border-amber text-amber font-bold' : 'border-line text-dim'}`}>
            Everyone
          </button>
          {people.filter(p => p.role === 'bar' || p.role === 'front_desk').map(p => (
            <button key={p.id} onClick={() => setStaffFilter(p.id)}
              className={`shrink-0 h-10 px-3 rounded-full border text-sm ${staffFilter === p.id
                ? 'bg-raise border-amber text-amber font-bold' : 'border-line text-dim'}`}>
              {p.full_name}
            </button>
          ))}
        </div>
      )}

      {/* A date switches from running balances to that DAY's credit
          activity. Balances are as-of-now by nature, so filtering them
          by date would be meaningless; what a daily view answers is
          who took credit that day and what came back. */}
      <div className="flex items-center gap-2 py-2">
        <input type="date" value={dayFilter} max={lagosToday()}
          onChange={e => setDayFilter(e.target.value)}
          className="h-11 px-3 rounded-xl bg-surface border border-line tnum" />
        {dayFilter
          ? <button onClick={() => setDayFilter('')}
              className="h-11 px-3 rounded-xl border border-amber text-amber text-sm font-semibold">
              Back to balances
            </button>
          : <span className="text-dim text-sm">Pick a date for that day's credit</span>}
      </div>

      {dayFilter ? (
        <>
          <div className="flex items-baseline justify-between py-2">
            <h2 className="text-dim">Credit on {dayFilter}</h2>
            <span className="tnum font-bold text-lg text-clay">
              {naira(dayData?.takenTotal || 0)}
            </span>
          </div>
          {dayData && dayData.repaidTotal > 0 && (
            <p className="text-leaf text-sm pb-2">
              {naira(dayData.repaidTotal)} repaid that day
            </p>
          )}
          {!dayData && <p className="text-dim py-8 text-center">Loading…</p>}
          {dayData && !dayData.rows.length && (
            <p className="text-dim py-8 text-center">No credit activity on {dayFilter}.</p>
          )}
          <ul className="divide-y divide-line/60">
            {(dayData?.rows || []).map(r => (
              <li key={r.kind + r.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{r.customer}</div>
                  <div className="text-dim text-sm truncate">
                    {r.item}{r.qty ? ` × ${r.qty}` : ''}
                    {locId === 'all' && locById[r.location_id]
                      ? ` · ${locById[r.location_id].name}` : ''}
                  </div>
                  <div className="text-dim text-sm truncate">{r.who}</div>
                </div>
                <span className={`tnum font-bold shrink-0 ${r.kind === 'repaid' ? 'text-leaf' : 'text-clay'}`}>
                  {r.kind === 'repaid' ? '-' : ''}{naira(r.amount)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
      <>
      <div className="flex items-baseline justify-between py-2">
        <h2 className="text-dim">
          Owed to {locById[locId]?.name || 'this department'}
          {staffFilter && people.find(p => p.id === staffFilter)
            ? ` · ${people.find(p => p.id === staffFilter).full_name}` : ''}
          <span className="ml-2 text-sm">
            ({owing.length} debtor{owing.length === 1 ? '' : 's'})
          </span>
        </h2>
        <span className="tnum font-bold text-lg text-clay">{naira(total)}</span>
      </div>

      <ul className="divide-y divide-line/60">
        {owing.map(c => (
          <li key={c.customer_id} className="py-3 flex items-center gap-3">
            <button onClick={() => openCustomer(c)} className="flex-1 min-w-0 text-left">
              <div className="font-semibold truncate">{c.name}</div>
              <div className="text-dim text-sm">
                {naira(c.credit_taken)} taken · {naira(c.repaid)} repaid
              </div>
              <div className="text-dim text-sm">
                {c.last_credit_date && (
                  <span>
                    {new Date(c.last_credit_date + 'T12:00:00').toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'short' })}
                    {c.first_credit_date && c.first_credit_date !== c.last_credit_date
                      && ` (since ${new Date(c.first_credit_date + 'T12:00:00')
                          .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })})`}
                  </span>
                )}
                {c.staff_name && <span> · by {c.staff_name}</span>}
              </div>
            </button>
            <span className="tnum font-bold text-clay">{naira(c.balance)}</span>
          </li>
        ))}
        {!owing.length && <li className="py-8 text-center text-dim">Nobody owes anything.</li>}
      </ul>
      </>
      )}

      {/* Room balances are NOT department credit. Showing them under
          every chip made a guest's room debt look like money owed at
          Minimart or MainBar. Shown under Reception and All
          departments, where they belong; under any other department a
          one-line pointer keeps them findable without pretending they
          belong there. */}
      {!dayFilter && hasReceptionAccess && !isReception && locId !== 'all' && (
        <p className="text-dim text-sm py-3">
          Guest room balances are under Reception.
        </p>
      )}
      {!dayFilter && hasReceptionAccess && (isReception || locId === 'all') && (() => {
        const gb = guestBalances || []
        // Must match what each ROW below displays and what
        // loadReceptionDashboard's deferredTotal uses. Summing only
        // .outstanding made the header disagree with the rows under
        // it for any guest carrying department credit — invisible
        // before migration 224 (front desk got no department rows at
        // all), obvious the moment that data started arriving.
        const gbTotal = gb.reduce((s, r) => s + r.outstanding + r.departmentCredit + r.billedToYou, 0)
        return (
          <>
            <div className="flex items-baseline justify-between py-2">
              <h2 className="text-dim">
                Guest room balances
                <span className="ml-2 text-sm">
                  ({gb.length} room{gb.length === 1 ? '' : 's'})
                </span>
              </h2>
              <span className="tnum font-bold text-lg text-clay">{naira(gbTotal)}</span>
            </div>
            <ul className="divide-y divide-line/60">
              {gb.map(g => (
                <li key={g.stay_id} className="py-3 flex items-center gap-3">
                  <button
                    onClick={() => setGuestPay({
                      stayId: g.stay_id, guestName: g.guest_name, roomNumber: g.room_number,
                      outstanding: g.outstanding, billingCycle: g.billing_cycle,
                      amount: String(g.outstanding), method: 'pos', split: null, isOverstay: false,
                    })}
                    className="flex-1 min-w-0 text-left">
                    <div className="font-semibold truncate">{g.guest_name || 'Guest'}</div>
                    <div className="text-dim text-sm">Room {g.room_number}</div>
                    {g.bill_to && (
                      <div className="text-amber text-sm font-semibold">→ Billed to {g.bill_to}</div>
                    )}
                    {g.departmentCredit > 0 && (
                      <div className="text-clay text-sm">
                        incl. {naira(g.departmentCredit)} at other departments
                      </div>
                    )}
                    {g.billedToYou > 0 && (
                      <div className="text-clay text-sm">
                        incl. {naira(g.billedToYou)} from other bills
                      </div>
                    )}
                  </button>
                  <span className="tnum font-bold text-clay">
                    {naira(g.outstanding + g.departmentCredit + g.billedToYou)}
                  </span>
                </li>
              ))}
              {guestBalances !== null && !gb.length && (
                <li className="py-8 text-center text-dim">No room balances outstanding.</li>
              )}
              {guestBalances === null && <li className="py-8 text-center text-dim">Loading…</li>}
            </ul>

            {/* Department accounts owing money but attached to no
                guest. This is the money that goes missing at checkout:
                the room gets settled and a bar or minimart balance in
                the guest's name is never seen, because nothing joins
                the two. Linking one makes it appear on that guest's
                folio from then on. */}
            {!!unlinked?.length && (
              <div className="mt-6 rounded-2xl border border-clay bg-surface p-4">
                <p className="font-semibold">Department accounts not linked to a guest</p>
                <p className="text-dim text-xs mt-1 mb-3">
                  These balances will not show on any guest's folio at checkout.
                  Link one to the guest it belongs to, if it belongs to a guest.
                </p>
                {unlinked.map(c => (
                  <div key={c.id} className="flex items-center gap-3 py-2 border-t border-line/60 first:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{c.name}</div>
                      <div className="text-dim text-xs">
                        {c.locationIds.map(id => locById[id]?.name).filter(Boolean).join(', ') || '—'}
                      </div>
                    </div>
                    <span className="tnum font-bold text-clay shrink-0">{naira(c.balance)}</span>
                    <button
                      onClick={() => { setLinkTarget({ customerId: c.id, name: c.name }); setLinking(true) }}
                      className="shrink-0 h-9 px-3 rounded-lg border border-amber text-amber text-sm font-semibold">
                      Link
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )
      })()}

      {open && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="p-5 print:hidden flex items-center justify-between">
              <button onClick={() => setOpen(null)} className="text-dim">Back</button>
              <button onClick={() => { setLinkTarget({ customerId: open.customer.customer_id, name: open.customer.name }); setLinking(true) }}
                className="text-amber text-sm font-semibold">
                Link to a guest
              </button>
            </div>

            <div id="statement-area" className="invoice-print px-5 pb-6">
              {/* letterhead */}
              <div className="invoice-head">
                <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
                <p className="text-dim">
                  {boot.branchName || ''}{locById[locId]?.name ? ` · ${locById[locId].name}` : ''} · Statement of Account
                </p>
              </div>

              <div className="invoice-meta mt-5">
                <div>
                  <div className="text-dim text-sm">Customer</div>
                  <div className="text-xl font-bold">{open.customer.name}</div>
                  {open.customer.phone && <div className="text-dim text-sm">{open.customer.phone}</div>}
                </div>
                <div className="text-right">
                  <div className="text-dim text-sm">Date</div>
                  <div className="tnum">
                    {new Date().toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                </div>
              </div>

              <h3 className="mt-6 mb-2 font-bold">Goods taken on credit</h3>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Department</th><th>Item</th>
                    <th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {open.ledger.credit.map(s2 => (
                    <tr key={s2.id}>
                      <td className="tnum">{s2.business_date?.slice(5)}</td>
                      <td>{locById[s2.location_id]?.name || '—'}</td>
                      <td>
                        {itemById[s2.stock_item_id]?.name || s2.description || '—'}
                        {s2.tier && s2.tier !== 'general' && (
                          <span className="text-dim"> ({tierLabel[s2.tier] || s2.tier})</span>
                        )}
                      </td>
                      <td className="num tnum">{s2.qty}</td>
                      <td className="num tnum">{naira(s2.unit_price)}</td>
                      <td className="num tnum">{naira(s2.credit)}</td>
                    </tr>
                  ))}
                  {!open.ledger.credit.length && (
                    <tr><td colSpan="6" className="text-dim">None recorded.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="5" className="num font-bold">Total credit</td>
                    <td className="num tnum font-bold">{naira(open.customer.credit_taken)}</td>
                  </tr>
                </tfoot>
              </table>

              <h3 className="mt-6 mb-2 font-bold">Payments received</h3>
              <table className="invoice-table">
                <thead>
                  <tr><th>Date</th><th>Method</th><th>Note</th><th className="num">Amount</th></tr>
                </thead>
                <tbody>
                  {open.ledger.repayments.map(r => (
                    <tr key={r.id}>
                      <td className="tnum">{r.paid_on?.slice(5)}</td>
                      <td>{methodLabel[r.method] || r.method}</td>
                      <td className="text-dim">{r.note || ''}</td>
                      <td className="num tnum">{naira(r.amount)}</td>
                    </tr>
                  ))}
                  {!open.ledger.repayments.length && (
                    <tr><td colSpan="4" className="text-dim">None yet.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="3" className="num font-bold">Total paid</td>
                    <td className="num tnum font-bold">{naira(open.customer.repaid)}</td>
                  </tr>
                </tfoot>
              </table>

              <div className="invoice-balance mt-6">
                <span>Balance owing</span>
                <span className="tnum">{naira(open.customer.balance)}</span>
              </div>

              {open.customer.balance > 0.009 && (
                <button onClick={() => setMovingToRoom({ customerId: open.customer.customer_id, locationId: locId,
                                                            amount: open.customer.balance })}
                  className="print:hidden mt-3 h-11 px-4 rounded-xl border border-amber text-amber text-sm font-semibold">
                  Move this balance to a room charge
                </button>
              )}

              <p className="text-dim text-sm mt-6 invoice-foot">
                Prepared from the Havilah inventory system. Please settle at the front desk
                or with the store manager.
              </p>
            </div>
          </div>

          <div className="p-5 border-t border-line flex gap-3 print:hidden">
            <button onClick={() => printStatement()}
              className="flex-1 h-14 rounded-2xl border border-line font-bold">Print / PDF</button>
            {(() => {
              const hiddenForRole = staff.role === 'auditor'
              // Awka storekeeper (or anyone in NO_ON_BEHALF) can't
              // record a repayment that would be credited to a
              // different staff member — the credit stays with
              // whoever originally gave it, so someone else has to
              // collect it. Buttons hides rather than errors on tap.
              const wouldBeOnBehalf = NO_ON_BEHALF.has(staff.id)
                && open.customer.staff_id
                && open.customer.staff_id !== staff.id
              const hidden = hiddenForRole || wouldBeOnBehalf
              return (
                <button onClick={() => setPay({ customerId: open.customer.customer_id,
                  amount: open.customer.balance, method: methods.find(m => m !== 'credit') || 'cash',
                  paidOn: lagosToday(), note: '',
                  balance: Number(open.customer.balance),
                  locationId: open.customer.location_id || locId,
                  creditStaffId: open.customer.staff_id || staff.id })}
                  className={`flex-1 h-14 rounded-2xl bg-amber text-bg font-bold ${
                    hidden ? 'hidden' : ''}`}>Record payment</button>
              )
            })()}
          </div>
          {isAdmin && (
            <div className="px-5 pb-5 print:hidden">
              <button onClick={() => setConfirmDel(open.customer)}
                className="w-full h-12 rounded-xl border border-clay text-clay font-semibold">
                Delete customer
              </button>
            </div>
          )}
        </div>
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete "{confirmDel.name}"?</h2>
          <p className="text-dim mt-2">
            This only succeeds if the customer has no sales or repayments
            against them, ever. If they do, you'll get an error explaining
            why — deactivate them instead in that case, which removes them
            from future credit sales without touching their history.
          </p>
          <button onClick={async () => {
              setDelBusy(true)
              try {
                await deleteCustomer(confirmDel.customer_id)
                toast('Customer deleted', 'success')
                setConfirmDel(null); setOpen(null); refresh()
              } catch (e) { toast(e.message, 'error') }
              setDelBusy(false)
            }} disabled={delBusy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {delBusy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button onClick={async () => {
              setDelBusy(true)
              try {
                await deactivateCustomer(confirmDel.customer_id)
                toast('Customer deactivated — hidden from future credit sales', 'success')
                setConfirmDel(null); setOpen(null); refresh()
              } catch (e) { toast(e.message, 'error') }
              setDelBusy(false)
            }} disabled={delBusy}
            className="mt-3 w-full h-12 rounded-xl border border-amber text-amber font-semibold disabled:opacity-40">
            Deactivate instead
          </button>
          <button onClick={() => setConfirmDel(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}

      {pay && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col">
          <div className="p-5 flex-1 overflow-y-auto">
            <button onClick={() => setPay(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">Record payment</h2>

            <p className="text-dim mt-2">
              Owing {naira(pay.balance ?? 0)}. Enter less than this for a part payment —
              the rest stays on their account.
            </p>

            <label className="block mt-6 text-dim">Amount</label>
            <input type="number" inputMode="decimal" value={pay.amount}
              onChange={e => setPay(p => ({ ...p, amount: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

            <label className="block mt-4 text-dim">Paid by</label>
            <div className="mt-2">
              <PaymentMethodPicker methods={methods.filter(m => m !== 'credit')} amount={pay.amount}
                value={pay} onChange={v => setPay(p => ({ ...p, ...v }))} />
            </div>

            <label className="block mt-4 text-dim">Date received</label>
            <input type="date" value={pay.paidOn}
              onChange={e => setPay(p => ({ ...p, paidOn: e.target.value }))}
              className="mt-2 h-14 px-4 rounded-xl bg-surface border border-line tnum" />

            <label className="block mt-4 text-dim">Note (optional)</label>
            <input value={pay.note} onChange={e => setPay(p => ({ ...p, note: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line" />
          </div>
          <div className="p-5 border-t border-line">
            {Number(pay.amount) > Number(pay.balance ?? 0) + 0.01 && (
              <p className="mt-4 text-clay">
                That is more than they owe. It will leave a credit balance.
              </p>
            )}
            {(() => {
              const canSave = pay.split ? paymentAllocated(pay, pay.amount) > 0 : Number(pay.amount) > 0
              return (
                <button onClick={submitPayment} disabled={busy || !canSave}
                  className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
                  {busy ? 'Saving…' : 'Save payment'}
                </button>
              )
            })()}
          </div>
        </div>
      )}
      {guestPay && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col">
          <div className="p-5 flex-1 overflow-y-auto">
            <button onClick={() => setGuestPay(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">{guestPay.guestName || 'Guest'}</h2>
            <p className="text-dim">Room {guestPay.roomNumber}</p>

            <p className="text-dim mt-4">
              Owing {naira(guestPay.outstanding)}. Enter less than this for a part payment —
              the rest stays on the bill.
            </p>

            <label className="block mt-6 text-dim">Amount</label>
            <input type="number" inputMode="decimal" value={guestPay.amount}
              onChange={e => setGuestPay(p => ({ ...p, amount: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

            <label className="block mt-4 text-dim">Paid by</label>
            <div className="mt-2">
              <PaymentMethodPicker methods={['pos', 'cash']} amount={guestPay.amount}
                value={guestPay} onChange={v => setGuestPay(p => ({ ...p, ...v }))} />
            </div>

            <label className="flex items-center gap-2 text-dim mt-4">
              <input type="checkbox" checked={guestPay.isOverstay}
                onChange={e => setGuestPay(p => ({ ...p, isOverstay: e.target.checked }))} />
              Over-stay payment
            </label>

            <button onClick={printGuestStatement} disabled={statementBusy}
              className="mt-4 text-dim text-sm underline disabled:opacity-40">
              {statementBusy ? 'Loading…' : 'Print guest statement'}
            </button>
          </div>
          <div className="p-5 border-t border-line">
            {Number(guestPay.amount) > guestPay.outstanding + 0.01 && (
              <p className="mb-4 text-clay">That is more than is owed. It will leave a credit balance.</p>
            )}
            <button onClick={submitGuestPayment}
              disabled={busy || paymentAllocated(guestPay, guestPay.amount) <= 0}
              className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Saving…' : 'Save payment'}
            </button>
          </div>
        </div>
      )}

      {guestStatement && (
        <FolioStatement room={guestStatement.room} folio={guestStatement.folio}
          orderLines={guestStatement.orderLines} payments={guestStatement.payments}
          departmentCredit={guestStatement.departmentCredit} billedToYou={guestStatement.billedToYou}
          branchName={boot.branchName} onClose={() => setGuestStatement(null)} />
      )}

      {linking && (
        <div className="fixed inset-0 z-[80] bg-bg flex flex-col px-6 pt-6">
          <button onClick={() => { setLinking(false); setLinkTarget(null); setLinkQuery(''); setLinkResults([]) }}
            className="text-dim self-start">Close</button>
          <h2 className="mt-3 text-2xl font-bold">Link to a guest</h2>
          <p className="text-dim mt-2">
            Connects {linkTarget?.name} to a real guest record, so their
            department credit shows up on that guest's own folio and
            statement — not just here.
          </p>
          <input value={linkQuery} onChange={e => setLinkQuery(e.target.value)} autoFocus
            placeholder="Search by name"
            className="mt-4 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
          <div className="mt-2 divide-y divide-line">
            {linkResults.map(g => (
              <button key={g.id} disabled={linkBusy} onClick={() => confirmLink(g)}
                className="block w-full text-left py-3">
                <div className="font-semibold">{g.full_name}</div>
                {g.phone && <div className="text-dim text-sm">{g.phone}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {movingToRoom && (
        <div className="fixed inset-0 z-[80] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Move {naira(movingToRoom.amount)} to a room charge?</h2>
          <p className="text-dim mt-2">
            Creates a real charge on this guest's current room, and clears this
            department balance since it's no longer owed here separately.
            The guest must already be linked and have a live stay — if not,
            this will tell you which.
          </p>
          <p className="text-clay mt-3 font-semibold">This cannot be undone.</p>
          <button onClick={confirmMoveToRoom} disabled={moveBusy}
            className="mt-6 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {moveBusy ? 'Moving…' : 'Move to room charge'}
          </button>
          <button onClick={() => setMovingToRoom(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}
