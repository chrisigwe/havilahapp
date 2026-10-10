import { useCallback, useEffect, useMemo, useState } from 'react'
import { lagosToday, methodLabel, naira, startingDept } from '../lib/format'
import { deleteRepayment, deleteRoomPayment, loadBalances, loadBalancesAsAt, loadRecovery, loadRoomPayments, updateRepayment } from '../lib/data'
import { useToast } from '../components/Toast'
import RoomChargeTracker from '../components/RoomChargeTracker'
import { OPENS_ON_ALL, OVERSIGHT, SUPERVISOR, is } from '../lib/roles'

// Deliberately excludes storekeeper — an explicit choice, not an
// oversight, matching how storekeeper's write access has been pulled
// back elsewhere in this app.
const CAN_EDIT_REPAYMENT = ['auditor', 'admin', 'manager', 'gm']

export default function Recovery({ boot }) {
  const { staff, locations, allLocations } = boot
  const toast = useToast()
  const canEdit = CAN_EDIT_REPAYMENT.includes(staff.role)
  const [editing, setEditing] = useState(null)   // the row being edited
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  // Oversight/audit roles must see EVERY department explicitly, not
  // whatever locations happen to be on their own staff_locations row
  // — matches Credit.jsx's identical fix. Bar/front_desk keep seeing
  // only their own assigned departments.
  const seesAllDepartments = is(staff.role, OVERSIGHT)
  const salesPoints = (seesAllDepartments ? allLocations : locations || [])
    .filter(l => l.is_sales_point && !l.is_store)
  // 'all' = every department; auditors open on it (their job is the
  // whole branch). Each repayment row already names its department.
  const openingDept = () => is(staff.role, OPENS_ON_ALL) ? 'all' : startingDept(salesPoints, staff, locations)
  const [locId, setLocId] = useState(openingDept)
  const [rows, setRows] = useState(null)
  // One day at a time, for reconciling a past day — the same control the
  // Credit page has. Null = the rolling 60-day view.
  const [dayFilter, setDayFilter] = useState(null)
  // What each customer still owes. CURRENT balance, not the balance as
  // it stood that evening: today's figure is what someone chasing the
  // debt needs, and it is always right. Labelled as current so it is
  // never mistaken for a historical one.
  const [balances, setBalances] = useState([])
  // What they owed at the END of the selected day, beside what they owe
  // now. The difference between the two is simply what has happened
  // since — more credit taken, or more repaid.
  const [asAtBalances, setAsAtBalances] = useState(null)
  // Whether this person can see room-payment recovery at all — a
  // role/assignment fact, not "which chip happens to be selected right
  // now". loadRoomPayments is already branch-wide, not department-
  // scoped; gating it on the currently-selected chip meant a
  // front-desk person with Reception in their own location list could
  // still miss it just by having a different chip selected.
  const hasReceptionAccess = seesAllDepartments || (locations || []).some(l => /reception/i.test(l.name))
  const [roomPayments, setRoomPayments] = useState(null)
  const canDeleteRoomPayment = is(staff.role, SUPERVISOR)
  const canDeleteRepayment = is(staff.role, SUPERVISOR)
  const [deletingRoomPayment, setDeletingRoomPayment] = useState(null)
  const [deletingRepayment, setDeletingRepayment] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function doDeleteRoomPayment() {
    setDeleteBusy(true)
    try {
      await deleteRoomPayment(deletingRoomPayment.id)
      toast('Payment removed', 'success')
      setDeletingRoomPayment(null); refreshRoomPayments()
    } catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setDeleteBusy(false)
  }

  async function doDeleteRepayment() {
    setDeleteBusy(true)
    try {
      await deleteRepayment(deletingRepayment.id)
      toast('Payment removed', 'success')
      setDeletingRepayment(null); refresh()
    } catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setDeleteBusy(false)
  }

  // When the GM switches branch, the previously-selected location id
  // belongs to the old branch and matches no chip here — leaving
  // nothing highlighted until a manual tap. Re-sync to a valid
  // default whenever the current selection isn't a location in this
  // branch.
  useEffect(() => {
    const valid = (locId === 'all' && seesAllDepartments) || salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(openingDept())
  }, [staff.branch_id])

  const refresh = useCallback(() => {
    loadBalances(staff.branch_id, locId === 'all' ? null : locId, null)
      .then(setBalances).catch(() => setBalances([]))
    // Only fetched when a day is actually selected.
    if (dayFilter) {
      loadBalancesAsAt(staff.branch_id, dayFilter, locId)
        .then(setAsAtBalances).catch(() => setAsAtBalances([]))
    } else setAsAtBalances(null)
    loadRecovery(staff.branch_id, locId === 'all' ? null : locId).then(setRows).catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId, dayFilter])  // dayFilter: the as-at balance must refetch when the date changes
  useEffect(refresh, [refresh])

  // Reception's recovered debt is room payments, not credit
  // repayments — a different table entirely, so a separate load
  // rather than folded into the one above.
  const refreshRoomPayments = useCallback(() => {
    if (!hasReceptionAccess) return
    loadRoomPayments(staff.branch_id).then(setRoomPayments).catch(() => setRoomPayments([]))
  }, [staff.branch_id, hasReceptionAccess])
  useEffect(refreshRoomPayments, [refreshRoomPayments])

  function openEdit(r) {
    setEditing(r)
    setDraft({ amount: String(r.amount), method: r.method, paid_on: r.paid_on, note: r.note || '' })
  }

  async function saveEdit() {
    setBusy(true)
    try {
      await updateRepayment(editing.id, {
        amount: Number(draft.amount), method: draft.method,
        paid_on: draft.paid_on, note: draft.note || null,
      })
      toast('Repayment updated', 'success')
      setEditing(null); refresh()
    } catch (e) { toast('Could not update: ' + e.message, 'error') }
    setBusy(false)
  }

  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of (rows || [])) {
      if (!m.has(r.paid_on)) m.set(r.paid_on, [])
      m.get(r.paid_on).push(r)
    }
    return [...m.entries()]
  }, [rows])

  const roomByDay = useMemo(() => {
    const m = new Map()
    for (const p of (roomPayments || [])) {
      if (!m.has(p.business_date)) m.set(p.business_date, [])
      m.get(p.business_date).push(p)
    }
    return [...m.entries()]
  }, [roomPayments])

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  const total = rows.reduce((s, r) => s + Number(r.amount), 0)
  const byMethod = {}
  for (const r of rows) byMethod[r.method] = (byMethod[r.method] || 0) + Number(r.amount)
  const roomTotal = (roomPayments || []).reduce((s, p) => s + Number(p.amount), 0)
  const roomByMethod = {}
  for (const p of (roomPayments || [])) roomByMethod[p.method] = (roomByMethod[p.method] || 0) + Number(p.amount)

  // Outstanding per customer, by name — customers are unique per branch,
  // so the name is a safe key here.
  const owedBy = {}
  for (const b of (balances || [])) {
    owedBy[b.name] = (owedBy[b.name] || 0) + Number(b.balance || 0)
  }
  const dayRows = dayFilter ? (rows || []).filter(r => r.paid_on === dayFilter) : []
  const dayTotal = dayRows.reduce((t, r) => t + Number(r.amount), 0)
  // One line per customer for the day: recovered, and what is still owed.
  // Owed at the END of the selected day, by name (unique per branch).
  const owedThen = {}
  for (const b of (asAtBalances || [])) {
    owedThen[b.name] = (owedThen[b.name] || 0) + Number(b.balance || 0)
  }
  const dayByCustomer = Object.values(dayRows.reduce((acc, r) => {
    const a = acc[r.customer_name] || (acc[r.customer_name] = {
      name: r.customer_name, recovered: 0, payments: [],
      outstanding: owedBy[r.customer_name] || 0,
      owedThen: asAtBalances ? (owedThen[r.customer_name] || 0) : null })
    a.recovered += Number(r.amount)
    a.payments.push(r)
    return acc
  }, {})).sort((x, y) => y.recovered - x.recovered)
  const dayByCollector = Object.entries(dayRows.reduce((acc, r) => {
    const k = r.recovered_by_name || 'Unknown'
    acc[k] = (acc[k] || 0) + Number(r.amount)
    return acc
  }, {})).sort((a, b) => b[1] - a[1])
  const stillOwedAfter = dayByCustomer.reduce((t, c) => t + c.outstanding, 0)
  const owedThenTotal = dayByCustomer.reduce((t, c) => t + (c.owedThen || 0), 0)

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

      {/* Pick a day to reconcile it; clear it for the rolling view. */}
      <div className="flex items-center gap-2 py-2">
        <input type="date" value={dayFilter || ''} max={lagosToday()}
          onChange={e => setDayFilter(e.target.value || null)}
          className="h-11 px-3 rounded-xl bg-raise border border-line tnum" />
        {dayFilter
          ? <button onClick={() => setDayFilter(null)}
              className="h-11 px-3 rounded-xl border border-amber text-amber text-sm font-semibold">
              Back to last 60 days
            </button>
          : <span className="text-dim text-sm">Pick a date to break down that day</span>}
      </div>

      {dayFilter ? (
        <>
          <div className="rounded-2xl border border-leaf bg-surface p-4 my-2">
            <div className="flex items-baseline justify-between">
              <span className="text-dim text-sm">Recovered on {dayFilter}</span>
              <span className="tnum text-2xl font-bold text-leaf">{naira(dayTotal)}</span>
            </div>
            {!!dayByCollector.length && (
              <div className="mt-2 pt-2 border-t border-line/60 space-y-1">
                <div className="text-dim text-xs">Who recovered it</div>
                {dayByCollector.map(([who, amt]) => (
                  <div key={who} className="flex justify-between text-sm">
                    <span className="text-dim truncate pr-2">{who}</span>
                    <span className="tnum">{naira(amt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!dayRows.length && (
            <p className="text-dim py-8 text-center">Nothing recovered on {dayFilter}.</p>
          )}

          {dayByCustomer.map(c => (
            <section key={c.name} className="mt-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold truncate">{c.name}</span>
                <span className="tnum font-bold text-leaf shrink-0">{naira(c.recovered)}</span>
              </div>
              {c.payments.map(r => (
                <div key={r.id} className="flex justify-between text-sm mt-1 pl-3">
                  <span className="text-dim truncate pr-2">
                    {methodLabel[r.method] || r.method}
                    {r.recovered_by_name && ` · ${r.recovered_by_name}`}
                    {locId === 'all' && r.location_name ? ` · ${r.location_name}` : ''}
                    {r.note && ` — ${r.note}`}
                  </span>
                  <span className="tnum text-dim shrink-0">{naira(r.amount)}</span>
                </div>
              ))}
              <div className="mt-2 pt-2 border-t border-line/60 space-y-0.5">
                {c.owedThen != null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-dim">Owed at the end of {dayFilter}</span>
                    <span className={`tnum ${c.owedThen > 0.009 ? 'text-clay' : 'text-leaf'}`}>
                      {c.owedThen > 0.009 ? naira(c.owedThen) : 'settled'}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-dim">Owed today</span>
                  <span className={`tnum font-bold ${c.outstanding > 0.009 ? 'text-clay' : 'text-leaf'}`}>
                    {c.outstanding > 0.009 ? naira(c.outstanding) : 'settled'}
                  </span>
                </div>
                {/* Name the difference rather than leave two figures to
                    be subtracted by eye. */}
                {c.owedThen != null && Math.abs(c.outstanding - c.owedThen) > 0.009 && (
                  <div className="text-dim text-xs">
                    {c.outstanding > c.owedThen
                      ? `${naira(c.outstanding - c.owedThen)} more credit taken since`
                      : `${naira(c.owedThen - c.outstanding)} repaid since`}
                  </div>
                )}
              </div>
            </section>
          ))}

          {!!dayRows.length && (
            <div className="mt-4 pt-3 border-t-2 border-line space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-dim">Recovered on {dayFilter}</span>
                <span className="tnum text-leaf">{naira(dayTotal)}</span>
              </div>
              {asAtBalances && (
                <div className="flex justify-between text-sm">
                  <span className="text-dim">Owed by these customers at the end of {dayFilter}</span>
                  <span className="tnum text-clay">{naira(owedThenTotal)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold">
                <span>Owed by these customers today</span>
                <span className="tnum text-clay">{naira(stillOwedAfter)}</span>
              </div>
              <p className="text-dim text-xs pt-1">
                "At the end of {dayFilter}" is what the books say about that day now.
                Entries backdated or corrected since will have changed it.
              </p>
            </div>
          )}
        </>
      ) : (
      <>
      <div className="rounded-2xl border border-leaf bg-surface p-4 my-2">
        <div className="text-dim text-sm">Recovered in the last 60 days</div>
        <div className="tnum text-2xl font-bold text-leaf">{naira(total)}</div>
        <div className="flex gap-4 mt-2 text-sm">
          {Object.entries(byMethod).map(([m, amt]) => (
            <span key={m} className="text-dim">
              {methodLabel[m] || m} <span className="tnum text-ink">{naira(amt)}</span>
            </span>
          ))}
        </div>
      </div>

      {!/reception/i.test(salesPoints.find(l => l.id === locId)?.name || '') && (
        <RoomChargeTracker mode="recovered" branchId={staff.branch_id}
          locationId={locId === 'all' ? null : locId} />
      )}

      {byDay.map(([day, items]) => (
        <section key={day} className="mt-4">
          <h3 className="text-dim text-sm">
            {new Date(day + 'T12:00:00').toLocaleDateString('en-NG',
              { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          </h3>
          <ul className="divide-y divide-line/60">
            {items.map(r => (
              <li key={r.id} className="py-3">
                <div className="flex items-baseline gap-3">
                  <span className="flex-1 min-w-0 truncate font-semibold">{r.customer_name}</span>
                  <span className="tnum font-bold text-leaf">{naira(r.amount)}</span>
                  {canEdit && (
                    <button onClick={() => openEdit(r)} className="text-dim text-sm underline">Edit</button>
                  )}
                </div>
                <div className="text-dim text-sm mt-0.5">
                  {methodLabel[r.method] || r.method}
                  {r.location_name && ` · ${r.location_name}`}
                  {r.recovered_by_name && ` · collected by ${r.recovered_by_name}`}
                  {r.credit_staff_name && r.credit_staff_name !== r.recovered_by_name
                    && ` · credit given by ${r.credit_staff_name}`}
                </div>
                {r.first_credit_date && (
                  <div className="text-dim text-sm">
                    Credit taken {new Date(r.first_credit_date + 'T12:00:00').toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'short' })}
                    {r.last_credit_date && r.last_credit_date !== r.first_credit_date
                      && ` (most recently ${new Date(r.last_credit_date + 'T12:00:00')
                          .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })})`}
                    {' '}· recovered {new Date(r.paid_on + 'T12:00:00').toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'short' })}
                  </div>
                )}
                {r.note && <div className="text-dim text-sm">{r.note}</div>}
                {canDeleteRepayment && (
                  <button onClick={() => setDeletingRepayment(r)}
                    className="mt-1.5 h-8 px-3 rounded-lg border border-clay text-clay text-sm font-semibold">
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {!rows.length && <p className="py-8 text-center text-dim">No payments recorded yet.</p>}
      </>
      )}

      {hasReceptionAccess && (
        <>
          <div className="rounded-2xl border border-leaf bg-surface p-4 my-2">
            <div className="text-dim text-sm">Recovered at Reception, last 60 days</div>
            <div className="tnum text-2xl font-bold text-leaf">{naira(roomTotal)}</div>
            <div className="flex gap-4 mt-2 text-sm">
              {Object.entries(roomByMethod).map(([m, amt]) => (
                <span key={m} className="text-dim">
                  {methodLabel[m] || m} <span className="tnum text-ink">{naira(amt)}</span>
                </span>
              ))}
            </div>
          </div>

          {roomByDay.map(([day, items]) => (
            <section key={day} className="mt-4">
              <h3 className="text-dim text-sm">
                {new Date(day + 'T12:00:00').toLocaleDateString('en-NG',
                  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
              </h3>
              <ul className="divide-y divide-line/60">
                {items.map(p => (
                  <li key={p.id} className="py-3">
                    <div className="flex items-baseline gap-3">
                      <span className="flex-1 min-w-0 truncate font-semibold">
                        {p.stays?.guests?.full_name || 'Guest'} · Room {p.stays?.rooms?.room_number || '—'}
                      </span>
                      <span className="tnum font-bold text-leaf">{naira(p.amount)}</span>
                    </div>
                    <div className="text-dim text-sm mt-0.5">
                      {methodLabel[p.method] || p.method}{p.is_overstay ? ' · over-stay' : ''}
                      {p.staff?.full_name && ` · collected by ${p.staff.full_name}`}
                      {p.remark && ` · ${p.remark}`}
                    </div>
                    {p.stays?.check_in_date && (
                      <div className="text-dim text-xs mt-0.5">
                        Stay since {p.stays.check_in_date}
                        {(() => {
                          const start = new Date(p.stays.check_in_date)
                          const end = new Date(p.stays.actual_out || p.stays.scheduled_out || lagosToday())
                          const nights = Math.max(Math.round((end - start) / 864e5), 1)
                          return ` · ${nights} night${nights === 1 ? '' : 's'}${p.stays.actual_out ? ` (out ${p.stays.actual_out})` : ''}`
                        })()}
                      </div>
                    )}
                    {canDeleteRoomPayment && (
                      <button onClick={() => setDeletingRoomPayment(p)}
                        className="mt-1.5 h-8 px-3 rounded-lg border border-clay text-clay text-sm font-semibold">
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {roomPayments !== null && !roomPayments.length && (
            <p className="py-8 text-center text-dim">No room payments recorded yet.</p>
          )}
          {roomPayments === null && <p className="py-8 text-center text-dim">Loading…</p>}
        </>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Edit repayment</h2>
          <p className="text-dim mt-1">{editing.customer_name}</p>

          <div className="mt-6">
            <div className="text-dim mb-1">Amount</div>
            <input type="number" inputMode="decimal" value={draft.amount}
              onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))}
              className="h-14 w-full px-4 rounded-xl bg-surface border border-line tnum text-xl" />
          </div>

          <div className="mt-4">
            <div className="text-dim mb-1">Method</div>
            <div className="flex gap-2">
              {['pos', 'cash', 'transfer'].map(m => (
                <button key={m} onClick={() => setDraft(d => ({ ...d, method: m }))}
                  className={`flex-1 h-12 rounded-xl border font-semibold ${draft.method === m
                    ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                  {methodLabel[m] || m}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-dim mb-1">Date</div>
            <input type="date" value={draft.paid_on} max={lagosToday()}
              onChange={e => setDraft(d => ({ ...d, paid_on: e.target.value }))}
              className="h-12 px-3 rounded-xl bg-surface border border-line tnum" />
          </div>

          <div className="mt-4">
            <div className="text-dim mb-1">Note (optional)</div>
            <input value={draft.note} onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
              className="h-12 w-full px-4 rounded-xl bg-surface border border-line" />
          </div>

          <button onClick={saveEdit} disabled={busy || !draft.amount}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={() => setEditing(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}

      {deletingRoomPayment && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete this payment?</h2>
          <p className="text-dim mt-2">
            {deletingRoomPayment.stays?.guests?.full_name || 'Guest'} · Room{' '}
            {deletingRoomPayment.stays?.rooms?.room_number || '—'} · {naira(deletingRoomPayment.amount)}
          </p>
          <p className="text-dim text-sm mt-2">
            For practice entries only. Removes just this one payment — the room's
            actual booking and every other charge or payment on it are untouched.
          </p>
          <button onClick={doDeleteRoomPayment} disabled={deleteBusy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {deleteBusy ? 'Deleting…' : 'Delete payment'}
          </button>
          <button onClick={() => setDeletingRoomPayment(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}

      {deletingRepayment && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete this payment?</h2>
          <p className="text-dim mt-2">
            {deletingRepayment.customer_name} · {naira(deletingRepayment.amount)}
          </p>
          <p className="text-dim text-sm mt-2">
            Removes this repayment permanently — the customer's outstanding balance
            goes back up by this amount. This cannot be undone.
          </p>
          <button onClick={doDeleteRepayment} disabled={deleteBusy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {deleteBusy ? 'Deleting…' : 'Delete payment'}
          </button>
          <button onClick={() => setDeletingRepayment(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}
