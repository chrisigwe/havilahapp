import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadStockMap, loadCounts, loadCountLines, saveCountLine,
         startCountOfType, submitCount, verifyCount, deleteCount,
         postOpeningBalance } from '../lib/data'
import { lagosToday } from '../lib/format'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import { useToast } from '../components/Toast'

const AUDITOR = ['auditor', 'gm', 'admin']
const MANAGE_ANY = ['storekeeper', 'manager', 'gm', 'admin']
const STAFF_COUNT = ['bar', 'front_desk']

export default function Counts({ boot }) {
  const { staff, allLocations, locations, items } = boot
  const canManageAny = MANAGE_ANY.includes(staff.role)
  const canCountOwn  = STAFF_COUNT.includes(staff.role)
  const canCount = canManageAny || canCountOwn
  const canVerify = AUDITOR.includes(staff.role)
  // staff pick from their own assigned department(s) only; a
  // storekeeper or above can count any department in the branch
  const pickableLocations = canManageAny ? allLocations : locations
  const toast = useToast()

  const [counts, setCounts] = useState(null)
  const [stockMap, setStockMap] = useState({})
  const [open, setOpen] = useState(null)      // { count, lines }
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(null)
  const [newLoc, setNewLoc] = useState(null)
  const [newType, setNewType] = useState('count')
  const [newDate, setNewDate] = useState(lagosToday())

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById  = useMemo(() => Object.fromEntries(allLocations.map(l => [l.id, l])), [allLocations])

  useEffect(() => {
    if (!newLoc && pickableLocations.length) setNewLoc(pickableLocations[0].id)
  }, [pickableLocations, newLoc])

  const refresh = useCallback(() => {
    loadCounts(staff.branch_id).then(setCounts).catch(e => toast(e.message, 'error'))
    loadStockMap(staff.branch_id).then(setStockMap).catch(console.error)
  }, [staff.branch_id])
  useEffect(refresh, [refresh])

  async function begin() {
    setBusy(true)
    try {
      const id = await startCountOfType({ staff, locationId: newLoc, stockMap, items,
        countType: newType, countDate: newDate })
      refresh()
      const lines = await loadCountLines(id)
      setOpen({ count: { id, location_id: newLoc, status: 'draft',
                         count_type: newType, count_date: newDate }, lines })
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function openCount(c) {
    try { setOpen({ count: c, lines: await loadCountLines(c.id) }) }
    catch (e) { toast(e.message, 'error') }
  }

  async function setLine(itemId, value) {
    const qty = value === '' ? null : Number(value)
    setOpen(o => ({ ...o, lines: o.lines.map(l =>
      l.stock_item_id === itemId ? { ...l, counted_qty: qty, pending: qty !== null } : l) }))
    if (qty === null) return
    const countId = open.count.id
    try {
      await saveCountLine(countId, itemId, qty)
      setOpen(o => o?.count.id === countId ? { ...o, lines: o.lines.map(l =>
        l.stock_item_id === itemId ? { ...l, pending: false } : l) } : o)
    } catch (e) {
      if (isConnectionError(e)) {
        // count lines are a plain upsert by (count, item) — safe to
        // replay later, the last value written always wins
        enqueue({ kind: 'countLine', payload: { countId, itemId, qty } })
        toast('No connection — this count will send once you are back online')
        flush()
      } else {
        setOpen(o => o?.count.id === countId ? { ...o, lines: o.lines.map(l =>
          l.stock_item_id === itemId ? { ...l, pending: false } : l) } : o)
        toast('Could not save that count: ' + e.message, 'error')
      }
    }
  }

  async function doSubmit() {
    setBusy(true)
    try { await submitCount(open.count.id); setOpen(null); refresh() }
    catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function doDelete() {
    setBusy(true)
    try { await deleteCount(confirmDel.id); setConfirmDel(null); setOpen(null); refresh() }
    catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setBusy(false)
  }

  async function doPostOpening() {
    setBusy(true)
    try { await postOpeningBalance(open.count.id); setOpen(null); refresh()
          toast('Posted — system quantities now match the count', 'success') }
    catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function doVerify() {
    setBusy(true)
    try { await verifyCount(open.count.id); setOpen(null); refresh() }
    catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  if (!counts) return <p className="px-5 text-dim">Loading…</p>

  const statusStyle = { draft: 'text-dim', submitted: 'text-amber', verified: 'text-leaf' }

  return (
    <div className="px-5">
      {canCount && (
        <div className="py-3">
          <div className="text-dim mb-2">
            {canManageAny ? 'Start a new count' : 'Count your stock at end of shift'}
          </div>
          {canManageAny && (
            <div className="flex gap-2 mb-2">
              {[['count', 'Stock count'], ['opening', 'Opening balance']].map(([k, label]) => (
                <button key={k} onClick={() => setNewType(k)}
                  className={`flex-1 h-11 rounded-xl border font-semibold ${newType === k
                    ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {canManageAny ? (
            <input type="date" value={newDate} max={lagosToday()}
              onChange={e => setNewDate(e.target.value)}
              className="w-full h-12 px-3 mb-2 rounded-xl bg-surface border border-line tnum" />
          ) : (
            <p className="text-dim text-sm mb-2">
              Dated today ({lagosToday()}) — submitted to your department's history
              with your name on it.
            </p>
          )}
          <div className="flex gap-2">
            {pickableLocations.length > 1 ? (
              <select value={newLoc || ''} onChange={e => setNewLoc(e.target.value)}
                className="flex-1 h-12 px-3 rounded-xl bg-surface border border-line">
                {pickableLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : (
              <div className="flex-1 h-12 px-3 rounded-xl bg-surface border border-line flex items-center text-dim">
                {pickableLocations[0]?.name || 'No department assigned — ask a manager'}
              </div>
            )}
            <button onClick={begin} disabled={busy || !newLoc}
              className="h-12 px-5 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
              Start
            </button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-line/60">
        {counts.map(c => (
          <li key={c.id}>
            <button onClick={() => openCount(c)} className="w-full text-left py-3">
              <div className="flex items-center gap-3">
                <span className="flex-1 font-semibold">{locById[c.location_id]?.name || '—'}</span>
                <span className={`text-sm font-bold ${statusStyle[c.status]}`}>
                  {c.status === 'draft' ? 'Counting'
                    : c.status === 'submitted' ? 'Awaiting auditor' : 'Verified'}
                </span>
              </div>
              <div className="text-dim text-sm">
                {c.count_date}{c.counter?.full_name ? ` · counted by ${c.counter.full_name}` : ''}
              </div>
            </button>
          </li>
        ))}
        {!counts.length && <li className="py-8 text-center text-dim">No counts yet.</li>}
      </ul>

      {open && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col">
          <div className="p-5 flex-1 overflow-y-auto">
            <button onClick={() => setOpen(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">
              {locById[open.count.location_id]?.name}
            </h2>
            <p className="text-dim">{open.count.count_date}</p>
            {open.count.counter?.full_name && (
              <p className="text-dim text-sm">Counted by {open.count.counter.full_name}</p>
            )}
            {open.count.verifier?.full_name && (
              <p className="text-dim text-sm">Verified by {open.count.verifier.full_name}</p>
            )}
            <p className="text-dim mt-2">
              {open.count.count_type === 'opening' && open.count.status === 'draft'
                ? 'Opening balance — posts straight to stock, no auditor step.'
                : open.count.status === 'draft' ? 'Enter what is physically there.'
                : open.count.status === 'submitted' ? 'Submitted — awaiting the auditor.'
                : 'Verified. Variances were posted as adjustments.'}
            </p>

            <ul className="mt-4 divide-y divide-line/60">
              {open.lines
                .filter(l => Number(l.system_qty) !== 0 || l.counted_qty !== null)
                .sort((a, b) => (itemById[a.stock_item_id]?.name || '')
                  .localeCompare(itemById[b.stock_item_id]?.name || ''))
                .map(l => {
                  const diff = l.counted_qty === null ? null
                    : Number(l.counted_qty) - Number(l.system_qty)
                  return (
                    <li key={l.stock_item_id} className="py-3 flex items-center gap-3">
                      <span className="flex-1 min-w-0 truncate">
                        {itemById[l.stock_item_id]?.name || '—'}
                      </span>
                      <span className="tnum text-dim w-12 text-right">{l.system_qty}</span>
                      {open.count.status === 'draft' ? (
                        <input type="number" inputMode="numeric"
                          value={l.counted_qty ?? ''} placeholder="—"
                          onChange={e => setLine(l.stock_item_id, e.target.value)}
                          className={`h-11 w-20 px-2 rounded-lg bg-surface border tnum text-center ${
                            l.pending ? 'border-amber' : 'border-line'}`} />
                      ) : (
                        <span className="tnum w-20 text-center">{l.counted_qty ?? '—'}</span>
                      )}
                      <span className={`tnum w-12 text-right ${!diff ? 'text-dim'
                        : diff > 0 ? 'text-leaf' : 'text-clay'}`}>
                        {diff === null ? '' : diff > 0 ? `+${diff}` : diff}
                      </span>
                    </li>
                  )
                })}
            </ul>
          </div>

          <div className="p-5 border-t border-line">
            {open.count.status === 'draft' && canCount && open.count.count_type === 'opening' && (
              <button onClick={doPostOpening} disabled={busy}
                className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
                {busy ? 'Posting…' : 'Post opening balance'}
              </button>
            )}
            {open.count.status === 'draft' && canCount && open.count.count_type !== 'opening' && (
              <button onClick={doSubmit} disabled={busy}
                className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
                {busy ? 'Submitting…' : 'Submit for verification'}
              </button>
            )}
            {open.count.status === 'submitted' && canVerify && (
              <button onClick={doVerify} disabled={busy}
                className="w-full h-16 rounded-2xl bg-leaf text-bg text-xl font-bold disabled:opacity-40">
                {busy ? 'Verifying…' : 'Verify and post variances'}
              </button>
            )}
            {open.count.status === 'submitted' && !canVerify && (
              <p className="text-center text-dim">Only an auditor can verify this count.</p>
            )}
            {open.count.status !== 'verified' && (
              canManageAny || canVerify
              || (open.count.counted_by === staff.id && open.count.status === 'draft')
            ) && (
              <button onClick={() => setConfirmDel(open.count)}
                className="mt-3 w-full h-12 rounded-xl border border-clay text-clay font-semibold">
                Delete this count
              </button>
            )}
          </div>
        </div>
      )}
      {confirmDel && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete this count?</h2>
          <p className="text-dim mt-2">
            {locById[confirmDel.location_id]?.name} · {confirmDel.count_date || 'today'}
          </p>
          <p className="text-dim mt-3">
            The count and everything entered on it are removed. Stock itself is
            not affected — nothing has been posted yet.
          </p>
          <button onClick={doDelete} disabled={busy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Deleting…' : 'Delete count'}
          </button>
          <button onClick={() => setConfirmDel(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}
