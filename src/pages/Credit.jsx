import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { naira, lagosToday, methodLabel, tierLabel } from '../lib/format'
import { loadBalances, loadCustomerLedger, saveRepayment, loadStaffForLocation,
         deleteCustomer, deactivateCustomer } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'

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
  const toast = useToast()
  const [open, setOpen] = useState(null)       // { customer, ledger }
  const [pay, setPay] = useState(null)
  const [busy, setBusy] = useState(false)
  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries((allLocations || []).map(l => [l.id, l])), [allLocations])

  const refresh = useCallback(() => {
    const requestedFor = requestKey   // snapshot at the moment this fetch was started
    loadBalances(staff.branch_id, locId, isEditor ? staffFilter : null)
      .then(data => { if (requestKeyRef.current === requestedFor) setRows(data) })
      .catch(e => toast(e.message, 'error'))
    // scoped to the CURRENTLY selected department, not branch-wide —
    // otherwise every bar hand's name shows as a filter chip on every
    // department's screen regardless of whether they work there
    if (isEditor && locId) {
      loadStaffForLocation(staff.branch_id, locId).then(ps => {
        if (requestKeyRef.current !== requestedFor) return   // a newer click already superseded this
        setPeople(ps)
        // a filter selected while looking at a different department
        // may not belong here — drop it rather than leave it stale
        setStaffFilter(cur => ps.some(p => p.id === cur) ? cur : null)
      })
    }
  }, [staff.branch_id, locId, staffFilter, isEditor, requestKey])
  useEffect(refresh, [refresh])

  async function openCustomer(c) {
    try {
      const ledger = await loadCustomerLedger(staff.branch_id, c.customer_id, locId,
        isEditor ? (c.staff_id || null) : null)
      setOpen({ customer: c, ledger })
    } catch (e) { toast(e.message, 'error') }
  }

  async function submitPayment() {
    setBusy(true)
    const args = {
      staffLite: { id: staff.id, branch_id: staff.branch_id },
      customerId: pay.customerId, amount: Number(pay.amount),
      method: pay.method, paidOn: pay.paidOn, note: pay.note,
      locationId: pay.locationId, creditStaffId: pay.creditStaffId,
    }
    try {
      try {
        await saveRepayment({ ...args, staff })
        toast('Payment recorded', 'success')
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'repayment', payload: args })
        toast('No connection — payment saved and will send when you are back online')
        flush()
      }
      setPay(null); setOpen(null); refresh()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  const owing = rows.filter(r => Number(r.balance) > 0.009)
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

      <div className="flex items-baseline justify-between py-2">
        <h2 className="text-dim">
          Owed to {locById[locId]?.name || 'this department'}
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

      {open && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="p-5 print:hidden">
              <button onClick={() => setOpen(null)} className="text-dim">Back</button>
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
                        {itemById[s2.stock_item_id]?.name || '—'}
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
            <div className="mt-2 flex flex-wrap gap-2">
              {methods.filter(m => m !== 'credit').map(m => (
                <button key={m} onClick={() => setPay(p => ({ ...p, method: m }))}
                  className={`h-12 px-4 rounded-xl border font-semibold ${pay.method === m
                    ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
                  {methodLabel[m] || m}
                </button>
              ))}
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
            <button onClick={submitPayment} disabled={busy || !(Number(pay.amount) > 0)}
              className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Saving…' : 'Save payment'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
