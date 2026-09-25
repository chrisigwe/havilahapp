import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, methodLabel, lagosToday } from '../lib/format'
import { loadRecovery, updateRepayment, deleteRepayment, loadRoomPayments, deleteRoomPayment } from '../lib/data'
import { useToast } from '../components/Toast'

// Deliberately excludes storekeeper — an explicit choice, not an
// oversight, matching how storekeeper's write access has been pulled
// back elsewhere in this app.
const CAN_EDIT_REPAYMENT = ['auditor', 'admin', 'manager', 'gm']

export default function Recovery({ boot }) {
  const { staff, locations } = boot
  const toast = useToast()
  const canEdit = CAN_EDIT_REPAYMENT.includes(staff.role)
  const [editing, setEditing] = useState(null)   // the row being edited
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const salesPoints = (locations || []).filter(l => l.is_sales_point && !l.is_store)
  const [locId, setLocId] = useState(staff.default_location_id || salesPoints[0]?.id || null)
  const [rows, setRows] = useState(null)
  const isReception = /reception/i.test(salesPoints.find(l => l.id === locId)?.name || '')
  const [roomPayments, setRoomPayments] = useState(null)
  const canDeleteRoomPayment = ['gm', 'admin'].includes(staff.role)
  const canDeleteRepayment = ['gm', 'admin'].includes(staff.role)
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
    const valid = salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(staff.default_location_id || salesPoints[0]?.id || null)
  }, [staff.branch_id])

  const refresh = useCallback(() => {
    loadRecovery(staff.branch_id, locId).then(setRows).catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId])
  useEffect(refresh, [refresh])

  // Reception's recovered debt is room payments, not credit
  // repayments — a different table entirely, so a separate load
  // rather than folded into the one above.
  const refreshRoomPayments = useCallback(() => {
    if (!isReception) return
    loadRoomPayments(staff.branch_id).then(setRoomPayments).catch(() => setRoomPayments([]))
  }, [staff.branch_id, isReception])
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

      {!isReception && (
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

      {isReception && (
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
