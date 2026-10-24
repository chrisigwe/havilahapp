import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { lagosToday, methodLabel, naira, startingDept, tierLabel } from '../lib/format'
import RoomChargeTracker from '../components/RoomChargeTracker'
import { checkRepeatPayment, deactivateCustomer, deleteCustomer, linkCustomerToGuest, loadBalances, loadCreditForMonth, loadCreditOnDate, loadCustomerLedger, loadFolio, loadGuestBalances, loadReservedValue, loadStaffForLocation, loadUnlinkedCustomerBalances, moveWorkaroundToRoom, recordStayPayment, saveRepayment, searchSimilarGuests } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import PaymentMethodPicker, { paymentParts, paymentAllocated } from '../components/PaymentMethodPicker'
import FolioStatement from '../components/FolioStatement'
import { EDITOR, OPENS_ON_ALL, OVERSIGHT, SUPERVISOR, is } from '../lib/roles'
import { accountStatementPdf, savePdf } from '../lib/pdfSheet'
import Notice from '../components/Notice'
import { tracked } from '../lib/loadfail'
import CreditChain from '../components/CreditChain'



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
  // 'all' = every department. Offered to whoever sees all departments;
  // auditors OPEN on it, since their job is the whole branch.
  const openingDept = () => is(staff.role, OPENS_ON_ALL) ? 'all' : startingDept(salesPoints, staff, locations)
  const [locId, setLocId] = useState(openingDept)
  // Re-sync the selected department when the GM switches branch — the
  // old branch's location id matches no chip here, so without this
  // nothing highlights until a manual tap.
  useEffect(() => {
    const valid = (locId === 'all' && seesAllDepartments) || salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(openingDept())
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
  const [upcoming, setUpcoming] = useState([])
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
  // A whole month, for the credit analysis that sets payroll
  // deductions. Separate from the day view: a day answers "what
  // happened", a month answers "what do they owe".
  const [monthFilter, setMonthFilter] = useState(null)   // 'YYYY-MM'
  const [monthRows, setMonthRows] = useState(null)
  const [dayData, setDayData] = useState(null)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState([])
  const [linkBusy, setLinkBusy] = useState(false)
  const [movingToRoom, setMovingToRoom] = useState(null)   // { customerId, locationId, amount }
  const [moveBusy, setMoveBusy] = useState(false)
  const [pay, setPay] = useState(null)
  const [busy, setBusy] = useState(false)
  // Shape only — neither touches what is loaded, so neither can change
  // a figure. Search filters the rows already in hand; sort reorders them.
  const [find, setFind] = useState('')
  const [sort, setSort] = useState('recent')   // recent | biggest | longest
  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries((allLocations || []).map(l => [l.id, l])), [allLocations])
  const isReception = /reception/i.test(locById[locId]?.name || '')

  const refresh = useCallback(() => {
    const requestedFor = requestKey   // snapshot at the moment this fetch was started
    loadBalances(staff.branch_id, locId === 'all' ? null : locId, isEditor ? staffFilter : null)
      .then(data => { if (requestKeyRef.current === requestedFor) setRows(data) })
      .catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId, staffFilter, isEditor, requestKey])
  useEffect(refresh, [refresh])

  // Reception's guest balances — a different data model entirely, so
  // a separate load rather than folded into the customer refresh above.
  const refreshGuestBalances = useCallback(() => {
    if (!hasReceptionAccess) return
    tracked('What guests owe', loadGuestBalances(staff.branch_id, isEditor ? staffFilter : null))
      .then(setGuestBalances).catch(() => setGuestBalances([]))
    tracked('Bookings not yet arrived', loadReservedValue(staff.branch_id)).then(setUpcoming).catch(() => setUpcoming([]))
  }, [staff.branch_id, hasReceptionAccess, isEditor, staffFilter])
  useEffect(refreshGuestBalances, [refreshGuestBalances])

  // Load the department-scoped staff list once per department change,
  // NOT on every refresh — because the auto-clear inside would also
  // reset staffFilter every time the user picks a filter chip, then
  // immediately drop the (correct) response as stale. This was the
  // real reason clicking a person still returned every debtor.
  useEffect(() => {
    if (!isEditor || !locId) return
    if (locId === 'all') { setPeople([]); setStaffFilter(null); return }
    loadStaffForLocation(staff.branch_id, locId).then(ps => {
      setPeople(ps)
      setStaffFilter(cur => ps.some(p => p.id === cur) ? cur : null)
    })
  }, [staff.branch_id, locId, isEditor])

  async function openCustomer(c) {
    try {
      const ledger = await loadCustomerLedger(staff.branch_id, c.customer_id, locId === 'all' ? null : locId,
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
    tracked('Customer accounts not linked to a guest', loadUnlinkedCustomerBalances(staff.branch_id)).then(setUnlinked).catch(() => setUnlinked([]))
  }, [hasReceptionAccess, staff.branch_id])
  useEffect(refreshUnlinked, [refreshUnlinked])

  useEffect(() => {
    if (!dayFilter) { setDayData(null); return }
    setDayData(null)
    loadCreditOnDate(staff.branch_id, dayFilter, locId === 'all' ? null : locId)
      .then(setDayData).catch(e => toast(e.message, 'error'))
  }, [dayFilter, staff.branch_id, locId, toast])

  useEffect(() => {
    if (!monthFilter) { setMonthRows(null); return }
    const [y, m] = monthFilter.split('-').map(Number)
    setMonthRows(null)
    tracked('Credit for the month', loadCreditForMonth(staff.branch_id, y, m, locId))
      .then(setMonthRows).catch(() => setMonthRows([]))
  }, [monthFilter, locId, staff.branch_id])

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
    // Same guard as the folio: a payment the attendant could not see land
    // gets entered a second time, and the screen is the one thing that
    // cannot tell them so.
    const parts = paymentParts(guestPay, guestPay.amount)
    const total = parts.reduce((s, p) => s + Number(p.amount || 0), 0)
    const repeat = await checkRepeatPayment(guestPay.stayId, total)
    if (repeat && !window.confirm(
          `${naira(repeat.amount)} was already recorded on this bill `
          + `${repeat.minutesAgo} minute${repeat.minutesAgo > 1 ? 's' : ''} ago`
          + `${repeat.who ? ` by ${repeat.who}` : ''}.\n\n`
          + `Is this a second ${naira(total)} the guest has just paid?\n\n`
          + 'Tap Cancel if it is the same money — it is already saved.')) {
      return
    }
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
  const inScope = rows.filter(r =>
    (!locId || locId === 'all' || r.location_id === locId)
    && (!staffFilter || r.staff_id === staffFilter))
  // All departments: rows come one per customer PER department, so combine
  // them — otherwise someone owing at two counters appears twice, as two
  // half-truths. Combined BEFORE the owing filter, so an overpayment at one
  // department correctly reduces what they owe overall.
  const combined = locId !== 'all' ? inScope : Object.values(inScope.reduce((acc, r) => {
    const a = acc[r.customer_id] || (acc[r.customer_id] = {
      ...r, credit_taken: 0, repaid: 0, balance: 0,
      location_id: null, staff_id: null, staff_name: null, deptIds: [] })
    a.credit_taken += Number(r.credit_taken); a.repaid += Number(r.repaid); a.balance += Number(r.balance)
    if (r.first_credit_date && (!a.first_credit_date || r.first_credit_date < a.first_credit_date)) a.first_credit_date = r.first_credit_date
    if (r.last_credit_date && (!a.last_credit_date || r.last_credit_date > a.last_credit_date)) a.last_credit_date = r.last_credit_date
    if (Number(r.balance) > 0.009 && !a.deptIds.includes(r.location_id)) a.deptIds.push(r.location_id)
    return acc
  }, {})).sort((x, y) => String(y.last_credit_date || '').localeCompare(String(x.last_credit_date || '')))
  const owing = combined.filter(r => Number(r.balance) > 0.009)
  const total = owing.reduce((s, r) => s + Number(r.balance), 0)

  // Which of the three questions is on screen. Derived, not stored, so
  // it cannot drift out of step with the two filters it reads.
  const view = monthFilter ? 'month' : dayFilter ? 'day' : 'balances'

  // Finding one person in a list of debtors was done by scrolling.
  // Filtering on what is already loaded — no query, no spinner.
  const needle = find.trim().toLowerCase()
  const matched = needle
    ? owing.filter(c => (c.name || '').toLowerCase().includes(needle))
    : owing
  // Recent stays the default: it is the order the data arrives in and
  // the order this page has always been read in. The other two are for
  // chasing money — who owes most, and who has been owing longest.
  const shown = sort === 'biggest'
    ? [...matched].sort((a, b) => Number(b.balance) - Number(a.balance))
    : sort === 'longest'
      ? [...matched].sort((a, b) =>
          String(a.first_credit_date || '9999-12-31').localeCompare(String(b.first_credit_date || '9999-12-31')))
      : matched

  // Days between a business date and today, counted in Lagos dates
  // rather than in milliseconds from the device clock.
  const daysSince = (d) => {
    if (!d) return null
    const a = new Date(d + 'T12:00:00'), b = new Date(lagosToday() + 'T12:00:00')
    return Math.round((b - a) / 86400000)
  }
  const oldest = owing.reduce((o, r) =>
    r.first_credit_date && (!o || r.first_credit_date < o) ? r.first_credit_date : o, null)
  const biggest = owing.reduce((m, r) => Math.max(m, Number(r.balance)), 0)
  const takenAllTime = owing.reduce((t, r) => t + Number(r.credit_taken || 0), 0)
  const repaidAllTime = owing.reduce((t, r) => t + Number(r.repaid || 0), 0)

  return (
    <div className="px-5">
      {salesPoints.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
          {seesAllDepartments && (
            <button onClick={() => setLocId('all')}
              className={`shrink-0 h-11 px-4 rounded-full border ${locId === 'all'
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              All departments
            </button>
          )}
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

      {/* ONE switch, three views (18 October 2026).
          This page carried a date row and a month row, each with its own
          hint and its own way back — four rows of controls before a
          single figure, and nothing saying that picking one abandoned
          the other. The view is chosen here; its picker appears under
          it, and only then.

          The three answer different questions and are never mixed.
          Balances are as-of-now by nature, so a date cannot filter
          them. A day answers "what happened that day". A month answers
          "what does each person owe", which is what sets the payroll
          deduction. */}
      <div className="flex gap-2 py-2">
        {[['balances', 'Balances'], ['day', 'A day'], ['month', 'A month']].map(([k, label]) => (
          <button key={k}
            onClick={() => {
              if (k === 'balances') { setDayFilter(''); setMonthFilter(null) }
              if (k === 'day') { setMonthFilter(null); setDayFilter(d => d || lagosToday()) }
              if (k === 'month') { setDayFilter(''); setMonthFilter(m => m || lagosToday().slice(0, 7)) }
            }}
            className={`flex-1 h-11 rounded-xl border font-semibold text-sm ${view === k
              ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'day' && (
        <div className="flex items-center gap-2 pb-2">
          <input type="date" value={dayFilter} max={lagosToday()}
            onChange={e => { if (e.target.value) { setDayFilter(e.target.value); setMonthFilter(null) } }}
            className="h-11 px-3 rounded-xl bg-surface border border-amber text-amber tnum" />
          <span className="text-dim text-sm">What was taken and repaid that day</span>
        </div>
      )}

      {view === 'month' && (
        <div className="flex items-center gap-2 pb-2">
          <input type="month" value={monthFilter || ''} max={lagosToday().slice(0, 7)}
            onChange={e => { if (e.target.value) { setMonthFilter(e.target.value); setDayFilter('') } }}
            className="h-11 px-3 rounded-xl bg-surface border border-amber text-amber tnum" />
          <span className="text-dim text-sm">What each owes, for deductions</span>
        </div>
      )}

      {monthFilter && (() => {
        if (monthRows === null) return <p className="text-dim py-8 text-center">Loading…</p>
        if (!monthRows.length) {
          return <p className="text-dim py-8 text-center">No credit activity that month.</p>
        }
        const staffRows = monthRows.filter(r => r.is_staff)
        const otherRows = monthRows.filter(r => !r.is_staff)
        const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0)

        const section = (title, rows, note) => !!rows.length && (
          <section className="mt-4">
            <div className="flex items-baseline justify-between pb-1 border-b border-line">
              <h2 className="font-semibold">{title}</h2>
              <span className="tnum font-bold text-clay">{naira(sum(rows, 'closing'))}</span>
            </div>
            {note && <p className="text-dim text-xs mt-1">{note}</p>}
            {rows.map(r => (
              <div key={r.customer_id} className="py-2 border-b border-line/60">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{r.name}</span>
                  <span className={`tnum font-bold shrink-0 ${
                    Number(r.closing) > 0.009 ? 'text-clay' : 'text-leaf'}`}>
                    {Number(r.closing) > 0.009 ? naira(r.closing) : 'settled'}
                  </span>
                </div>
                <div className="text-dim text-xs">
                  owed {naira(r.opening)} at the start
                  {' · '}took {naira(r.taken)}
                  {' · '}repaid {naira(r.repaid)}
                </div>
              </div>
            ))}
          </section>
        )

        return (
          <>
            <div className="rounded-2xl border border-amber bg-surface p-4 my-2">
              <div className="text-dim text-sm">Owed at the end of {monthFilter}</div>
              <div className="tnum text-2xl font-bold text-clay">
                {naira(sum(monthRows, 'closing'))}
              </div>
              <div className="text-dim text-sm mt-1">
                took {naira(sum(monthRows, 'taken'))} · repaid {naira(sum(monthRows, 'repaid'))}
                {' '}during the month
              </div>
            </div>

            {section('Staff', staffRows,
              'The closing figure is what each owes in total, not just this month — '
              + 'that is normally what gets deducted.')}
            {section('Everyone else', otherRows)}
          </>
        )
      })()}

      {monthFilter ? null : dayFilter ? (
        <>
          {/* Credit raised and repayments received are SEPARATE
              sections with separate totals. They were one list with
              repayments shown as negatives, which left neither figure
              readable: credit raised increases what customers owe, a
              repayment reduces it and brings cash in. An accountant
              needs both, apart. */}
          {!dayData && <p className="text-dim py-8 text-center">Loading…</p>}

          {dayData && !dayData.rows.length && (
            <p className="text-dim py-8 text-center">No credit activity on {dayFilter}.</p>
          )}

          {!!dayData?.rows.filter(r => r.kind !== 'repaid').length && (
            <>
              <div className="flex items-baseline justify-between py-2 mt-2">
                <h2 className="text-dim">Credit taken on {dayFilter}</h2>
                <span className="tnum font-bold text-lg text-clay">{naira(dayData.takenTotal || 0)}</span>
              </div>
              <ul className="divide-y divide-line/60">
                {dayData.rows.filter(r => r.kind !== 'repaid').map(r => (
                  <li key={r.kind + r.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{r.customer}</div>
                      <div className="text-dim text-sm truncate">
                        {r.item}{r.qty ? ` × ${r.qty}` : ''}
                        {locId === 'all' && locById[r.location_id] ? ` · ${locById[r.location_id].name}` : ''}
                      </div>
                      <div className="text-dim text-sm truncate">{r.who}</div>
                    </div>
                    <span className="tnum font-bold shrink-0 text-clay">{naira(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {!!dayData?.rows.filter(r => r.kind === 'repaid').length && (
            <>
              <div className="flex items-baseline justify-between py-2 mt-5 border-t border-line">
                <h2 className="text-dim">Repayments received on {dayFilter}</h2>
                <span className="tnum font-bold text-lg text-leaf">{naira(dayData.repaidTotal || 0)}</span>
              </div>
              <ul className="divide-y divide-line/60">
                {dayData.rows.filter(r => r.kind === 'repaid').map(r => (
                  <li key={r.kind + r.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{r.customer}</div>
                      <div className="text-dim text-sm truncate">
                        {locId === 'all' && locById[r.location_id] ? `${locById[r.location_id].name} · ` : ''}
                        {r.who}
                      </div>
                    </div>
                    <span className="tnum font-bold shrink-0 text-leaf">{naira(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* The day in one line: what customers owe went up by X, down
              by Y, so the net movement is Z. */}
          {!!dayData?.rows.length && (
            <div className="mt-5 pt-3 border-t-2 border-line space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-dim">Credit taken (owed to us, up)</span>
                <span className="tnum text-clay">+{naira(dayData.takenTotal || 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-dim">Repayments received (owed to us, down)</span>
                <span className="tnum text-leaf">-{naira(dayData.repaidTotal || 0)}</span>
              </div>
              <div className="flex justify-between font-bold pt-1 border-t border-line/60">
                <span>Net change in what customers owe</span>
                <span className="tnum">
                  {(dayData.takenTotal || 0) - (dayData.repaidTotal || 0) >= 0 ? '+' : ''}
                  {naira((dayData.takenTotal || 0) - (dayData.repaidTotal || 0))}
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
      <>
      {/* The figure this page exists for, at the top of it and in a size
          that matches what it means. It was a small number on the right
          of a heading, the same weight as the headings above it. */}
      <section className="rounded-2xl border border-clay bg-surface p-4 mt-1">
        <div className="text-dim text-sm">
          {locId === 'all' ? 'Owed across all departments' : `Owed to ${locById[locId]?.name || 'this department'}`}
          {staffFilter && people.find(p => p.id === staffFilter)
            ? ` · ${people.find(p => p.id === staffFilter).full_name}` : ''}
        </div>
        <div className="tnum text-3xl font-bold text-clay">{naira(total)}</div>
        <div className="text-dim text-sm mt-1">
          {owing.length} {owing.length === 1 ? 'person owes' : 'people owe'} it
          {biggest > 0 && <> · biggest {naira(biggest)}</>}
          {oldest && <> · oldest since {new Date(oldest + 'T12:00:00')
            .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</>}
        </div>
        {/* All time, and said so. These two are each customer's whole
            history at this department, not this month's — summing them
            under a monthly heading is how a figure gets quoted wrongly. */}
        {takenAllTime > 0 && (
          <div className="text-dim text-xs mt-2 pt-2 border-t border-line">
            {naira(takenAllTime)} given and {naira(repaidAllTime)} paid back by these{' '}
            {owing.length === 1 ? 'person' : 'people'}, all time
          </div>
        )}
      </section>

      {/* Only once the list is long enough to be worth searching. */}
      {owing.length > 4 && (
        <>
          <input value={find} onChange={e => setFind(e.target.value)}
            placeholder="Find a name" aria-label="Find a name"
            className="mt-3 h-11 w-full px-3 rounded-xl bg-surface border border-line" />
          <div className="flex gap-2 mt-2">
            {[['recent', 'Recent'], ['biggest', 'Biggest'], ['longest', 'Oldest']].map(([k, label]) => (
              <button key={k} onClick={() => setSort(k)}
                className={`flex-1 h-10 rounded-xl border text-sm font-semibold ${sort === k
                  ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      <ul className="mt-2 divide-y divide-line/60">
        {shown.map(c => {
          const days = daysSince(c.last_credit_date)
          return (
          <li key={c.customer_id}>
            {/* The whole row opens the statement. It always did, but
                nothing said so — no chevron, no label — so staff asked
                where a customer's history was. */}
            <button onClick={() => openCustomer(c)}
              className="w-full py-3 flex items-center gap-3 text-left">
              <div className="flex-1 min-w-0">
                <div className="font-semibold break-words">{c.name}</div>
                <div className="text-dim text-sm">
                  {naira(c.credit_taken)} taken · {naira(c.repaid)} repaid
                </div>
                {!!c.deptIds?.length && (
                  <div className="text-dim text-xs">
                    {c.deptIds.map(id => locById[id]?.name).filter(Boolean).join(', ')}
                  </div>
                )}
                <div className="text-sm">
                  {/* Days, not just a date. "3 Oct" needs working out;
                      "15 days ago" is the thing being judged. Clay past
                      a month — a fact about when credit was last taken,
                      which is all this data says: nothing here records
                      a due date, so nothing here calls it overdue. */}
                  {days != null && (
                    <span className={days >= 30 ? 'text-clay' : 'text-dim'}>
                      last took credit {days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}
                    </span>
                  )}
                  {c.first_credit_date && c.first_credit_date !== c.last_credit_date && (
                    <span className="text-dim"> · since {new Date(c.first_credit_date + 'T12:00:00')
                      .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</span>
                  )}
                  {c.staff_name && <span className="text-dim"> · by {c.staff_name}</span>}
                </div>
              </div>
              <span className="shrink-0 text-right">
                <span className="tnum font-bold text-clay block">{naira(c.balance)}</span>
                <span className="text-dim text-xs">statement ›</span>
              </span>
            </button>
          </li>
        )})}
        {!owing.length && <li className="py-8 text-center text-dim">Nobody owes anything.</li>}
        {!!owing.length && !shown.length && (
          <li className="py-8 text-center text-dim">
            Nobody owing matches “{find}”. {owing.length} {owing.length === 1 ? 'debtor' : 'debtors'} in all.
          </li>
        )}
      </ul>
      </>
      )}

      {/* Room balances are NOT department credit. Showing them under
          every chip made a guest's room debt look like money owed at
          Minimart or MainBar. Shown under Reception and All
          departments, where they belong; under any other department a
          one-line pointer keeps them findable without pretending they
          belong there. */}
      {!dayFilter && !monthFilter && !isReception && (
        <RoomChargeTracker branchId={staff.branch_id} locationId={locId === 'all' ? null : locId} />
      )}
      {!dayFilter && !monthFilter && hasReceptionAccess && !isReception && locId !== 'all' && (
        <p className="text-dim text-sm py-3">
          Guest room balances are under Reception.
        </p>
      )}
      {!dayFilter && !monthFilter && hasReceptionAccess && (isReception || locId === 'all') && (() => {
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
            <section className="rounded-2xl border border-clay bg-surface p-4 mt-6">
              <div className="text-dim text-sm">Guest room balances</div>
              <div className="tnum text-2xl font-bold text-clay">{naira(gbTotal)}</div>
              <div className="text-dim text-sm mt-1">
                across {gb.length} room{gb.length === 1 ? '' : 's'} · tap a room to take payment
              </div>
            </section>
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
                  <span className="shrink-0 text-right">
                    <span className="tnum font-bold text-clay block">
                      {naira(g.outstanding + g.departmentCredit + g.billedToYou)}
                    </span>
                    <span className="text-dim text-xs">take payment ›</span>
                  </span>
                </li>
              ))}
              {guestBalances !== null && !gb.length && (
                <li className="py-8 text-center text-dim">No room balances outstanding.</li>
              )}
              {guestBalances === null && <li className="py-8 text-center text-dim">Loading…</li>}
            </ul>

            {/* Rooms booked but not yet arrived. Deliberately NOT counted
                above: a reservation is not a debt until the guest checks
                in, and eleven PSN rooms held for November were reading as
                ₦1,650,000 owed — five times every real balance together.
                Still shown, because an unpaid group booking is worth
                seeing while a deposit can still be asked for. */}
            {upcoming.length > 0 && (() => {
              const unpaid = upcoming.filter(u => u.unpaid > 0.009)
              if (!unpaid.length) return null
              return (
                <details className="mt-4 rounded-2xl border border-line bg-surface p-4">
                  <summary className="flex items-baseline justify-between cursor-pointer">
                    <span>
                      <span className="font-semibold">Booked, not yet arrived</span>
                      <span className="text-dim text-sm block">
                        {unpaid.length} room{unpaid.length === 1 ? '' : 's'} · not counted as owing
                      </span>
                    </span>
                    <span className="tnum font-bold text-amber">
                      {naira(unpaid.reduce((s2, u) => s2 + u.unpaid, 0))}
                    </span>
                  </summary>
                  <ul className="mt-3 divide-y divide-line/60">
                    {unpaid.map(u => (
                      <li key={u.stayId} className="py-2 flex items-baseline gap-3 text-sm">
                        <span className="flex-1 min-w-0 truncate">
                          {u.guest}
                          <span className="text-dim"> · Room {u.room} · arrives {u.arrives}</span>
                        </span>
                        <span className="tnum text-dim shrink-0">{naira(u.unpaid)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })()}

            {/* Department accounts owing money but attached to no
                guest. This is the money that goes missing at checkout:
                the room gets settled and a bar or minimart balance in
                the guest's name is never seen, because nothing joins
                the two. Linking one makes it appear on that guest's
                folio from then on. */}
            {!!unlinked?.length && (
              <Notice tone="problem" className="mt-6"
                title="Department accounts not linked to a guest">
                <p className="mb-3">
                  These balances will not show on any guest&#39;s folio at checkout.
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
              </Notice>
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

              {open.customer.balance > 0.009 && locId === 'all' && (
                <p className="print:hidden mt-3 text-dim text-sm">
                  Viewing all departments. To record a payment or move this balance
                  to a room, open the department it was owed at.
                </p>
              )}
              {open.customer.balance > 0.009 && locId !== 'all' && (
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
            <button onClick={() => savePdf(accountStatementPdf({
              branchName: boot.branchName,
              where: locById[locId]?.name,
              customerName: open.customer.name,
              creditRows: open.ledger.credit.map(s2 => ({
                date: s2.business_date?.slice(5) || '',
                department: locById[s2.location_id]?.name || '—',
                item: `${itemById[s2.stock_item_id]?.name || s2.description || '—'}${s2.tier && s2.tier !== 'general' ? ` (${tierLabel[s2.tier] || s2.tier})` : ''}`,
                qty: s2.qty, unit: s2.unit_price, amount: s2.credit,
              })),
              creditTotal: open.customer.credit_taken,
              payments: open.ledger.repayments.map(r => ({
                date: r.paid_on?.slice(5) || '', method: methodLabel[r.method] || r.method,
                note: r.note || '', amount: r.amount,
              })),
              paidTotal: open.customer.repaid,
              balance: open.customer.balance,
            }), `Statement ${open.customer.name}`)}
              className="flex-1 h-14 rounded-2xl border border-line font-bold">Save / share PDF</button>
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
              // A repayment must be credited to one department; in the all
              // view it would otherwise fall back to the literal 'all'.
              const hidden = hiddenForRole || wouldBeOnBehalf || locId === 'all'
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
          {/* What was taken, and how each of it came back (570).
              Kept off the printed statement, which is the formal
              account; this is the working view — the one that answers
              "has he paid for the Desperados yet". */}
          <div className="px-5 pb-5 print:hidden">
            <h3 className="font-semibold mb-1">What was taken, and how it came back</h3>
            <CreditChain branchId={staff.branch_id} customerId={open.customer.customer_id} />
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
