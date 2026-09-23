import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { naira, lagosToday, methodLabel, tierLabel } from '../lib/format'
import { loadBalances, loadCustomerLedger, saveRepayment, loadStaffForLocation,
         deleteCustomer, deactivateCustomer, loadGuestBalances, recordStayPayment, loadFolio,
         linkCustomerToGuest, searchSimilarGuests } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import PaymentMethodPicker, { paymentParts, paymentAllocated } from '../components/PaymentMethodPicker'
import FolioStatement from '../components/FolioStatement'

function printStatement() {
  document.querySelectorAll('.invoice-print').forEach(el => {
    el.style.display = el.id === 'statement-area' ? '' : 'none'
  })
  window.print()
  document.querySelectorAll('.invoice-print').forEach(el => { el.style.display = '' })
}

export default function Credit({ boot }) {
  const { staff, items, methods, allLocations, locations } = boot
  const isEditor = ['storekeeper', 'manager', 'gm', 'admin'].includes(staff.role)
  const isAdmin = ['gm', 'admin'].includes(staff.role)
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
  const seesAllDepartments = isEditor || staff.role === 'auditor'
  const salesPoints = (seesAllDepartments ? allLocations : locations || [])
    .filter(l => l.is_sales_point && !l.is_store)
  const [locId, setLocId] = useState(staff.default_location_id || salesPoints[0]?.id || null)
  // Re-sync the selected department when the GM switches branch — the
  // old branch's location id matches no chip here, so without this
  // nothing highlights until a manual tap.
  useEffect(() => {
    const valid = salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(staff.default_location_id || salesPoints[0]?.id || null)
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
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState([])
  const [linkBusy, setLinkBusy] = useState(false)
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
    if (!isReception) return
    loadGuestBalances(staff.branch_id, isEditor ? staffFilter : null)
      .then(setGuestBalances).catch(() => setGuestBalances([]))
  }, [staff.branch_id, isReception, isEditor, staffFilter])
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

  async function confirmLink(guest) {
    setLinkBusy(true)
    try {
      await linkCustomerToGuest(open.customer.customer_id, guest.id)
      toast(`Linked to ${guest.full_name}`, 'success')
      setLinking(false); setLinkQuery(''); setLinkResults([])
    } catch (e) { toast(e.message, 'error') }
    setLinkBusy(false)
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
      const { orders, payments, folio, departmentCredit } = await loadFolio(guestPay.stayId)
      const orderLines = orders.flatMap(o => (o.order_items || []).map(li => ({ ...li, date: o.business_date })))
      setGuestStatement({
        room: { room_number: guestPay.roomNumber, guest_name: guestPay.guestName,
                check_in_date: folio?.check_in_date, scheduled_out: folio?.scheduled_out },
        folio, orderLines, payments, departmentCredit,
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

      {!isReception && (
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

      {isReception && (() => {
        const gb = guestBalances || []
        const gbTotal = gb.reduce((s, r) => s + r.outstanding, 0)
        return (
          <>
            <div className="flex items-baseline justify-between py-2">
              <h2 className="text-dim">
                Owed to Reception
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
                  </button>
                  <span className="tnum font-bold text-clay">{naira(g.outstanding + g.departmentCredit)}</span>
                </li>
              ))}
              {guestBalances !== null && !gb.length && (
                <li className="py-8 text-center text-dim">No room balances outstanding.</li>
              )}
              {guestBalances === null && <li className="py-8 text-center text-dim">Loading…</li>}
            </ul>
          </>
        )
      })()}

      {open && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="p-5 print:hidden flex items-center justify-between">
              <button onClick={() => setOpen(null)} className="text-dim">Back</button>
              <button onClick={() => setLinking(true)} className="text-amber text-sm font-semibold">
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
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line" />

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
          departmentCredit={guestStatement.departmentCredit}
          branchName={boot.branchName} onClose={() => setGuestStatement(null)} />
      )}

      {linking && (
        <div className="fixed inset-0 z-[80] bg-bg flex flex-col px-6 pt-6">
          <button onClick={() => { setLinking(false); setLinkQuery(''); setLinkResults([]) }}
            className="text-dim self-start">Close</button>
          <h2 className="mt-3 text-2xl font-bold">Link to a guest</h2>
          <p className="text-dim mt-2">
            Connects {open?.customer?.name} to a real guest record, so their
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
    </div>
  )
}
