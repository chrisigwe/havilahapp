import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadStockMap, loadCounts, loadCountLines, saveCountLine, saveCountReason,
         startCountOfType, submitCount, verifyCount, deleteCount,
         postOpeningBalance, auditorAdjustCountLine } from '../lib/data'
import { lagosToday, startingDept } from '../lib/format'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import { useToast } from '../components/Toast'
import Notice from '../components/Notice'

// Why a counted figure differs from the book (migration 545).
//
// A list, not a blank box. A compulsory empty field gets you
// "adjustment", "correction" and ".", which is a field gained and
// nothing else; a short list of real answers is easy to be honest with
// AND countable later — "how much did Nnewi lose to expiry this
// quarter" is a question free text can never answer.
//
// Order matters: the ones that cost money come first, so nobody has to
// scroll past "Miscount" to admit a loss.
const REASONS = [
  'Breakage', 'Expired', 'Theft or loss', 'Supplier short-delivered',
  'Miscount corrected', 'Found extra', 'Opening balance wrong',
]
const hasReason = (l) => !!(l?.variance_reason || '').trim()
       && (l.variance_reason || '').trim().length >= 4
const differs = (l) => l.counted_qty !== null && l.counted_qty !== undefined
       && Number(l.counted_qty) !== Number(l.system_qty)

const AUDITOR = ['auditor', 'gm', 'admin']
// A count with ANY adjusted line needs a second person to verify it —
// whoever corrected a line must not also sign it off (decision C,
// migration 259). Two rules, both mirrored from verify_stock_count:
// the ROLE (manager/gm/admin for adjusted counts) and the PERSON (never
// whoever adjusted a line — auditors, GMs and admins can all adjust).
const VERIFY_ADJUSTED = ['manager', 'gm', 'admin']
const MANAGE_ANY = ['storekeeper', 'manager', 'gm', 'admin']
const STAFF_COUNT = ['bar', 'front_desk']
// Deleting a SUBMITTED count: exactly these five roles, not derived
// from MANAGE_ANY or AUDITOR (adds 'auditor', who could previously
// verify but not delete). A DRAFT is a separate rule entirely — only
// the staff member still counting it may remove it; see the render
// logic below rather than this list.
// Auditor removed (255): a count is evidence, and the auditor reviews it.
const CAN_DELETE_COUNT = ['storekeeper', 'manager', 'gm', 'admin']

// A typed count far from what the system expects is more often a slip
// (240 for 24, 2 for 20) than a real loss. Flag it for a second look.
function looksOff(l) {
  if (l.counted_qty === null || l.counted_qty === undefined) return false
  const sys = Number(l.system_qty), got = Number(l.counted_qty)
  const diff = Math.abs(got - sys)
  if (diff < 5) return false
  return sys === 0 ? got >= 10 : diff / Math.abs(sys) >= 0.5
}

export default function Counts({ boot }) {
  const { staff, allLocations, locations, items } = boot
  const canManageAny = MANAGE_ANY.includes(staff.role)
  const canCountOwn  = STAFF_COUNT.includes(staff.role)
  const canCount = canManageAny || canCountOwn
  // Adjusting a line and verifying the count used to share one gate.
  // They are separate now: adjusting stays with auditors (and GM/admin);
  // who may VERIFY depends on whether any line was adjusted.
  const canAdjust = AUDITOR.includes(staff.role)
  const canDelete = CAN_DELETE_COUNT.includes(staff.role)
  // staff pick from their own assigned department(s) only; a
  // storekeeper or above can count any department in the branch
  const pickableLocations = canManageAny ? allLocations : locations
  const toast = useToast()

  const [counts, setCounts] = useState(null)
  // Without this a failed load left counts at null and the page sat on
  // "Loading…" for good, which reads as a slow line rather than a fault
  // (19 October 2026).
  const [countsErr, setCountsErr] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [stockMap, setStockMap] = useState({})
  const [open, setOpen] = useState(null)      // { count, lines }
  // Recomputed from the lines on screen, so the moment an auditor adjusts a
  // line their own Verify button gives way to the GM/manager note.
  const hasAdjusted = !!open?.lines?.some(l => l.auditor_adjusted)
  const iAdjusted = !!open?.lines?.some(l => l.auditor_adjusted && l.adjusted_by === staff.id)
  const canVerifyThis = (hasAdjusted ? VERIFY_ADJUSTED : AUDITOR).includes(staff.role) && !iAdjusted
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(null)
  const [newLoc, setNewLoc] = useState(null)
  const [newType, setNewType] = useState('count')
  const [newDate, setNewDate] = useState(lagosToday())

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById  = useMemo(() => Object.fromEntries(allLocations.map(l => [l.id, l])), [allLocations])

  useEffect(() => {
    // Also re-point it when the CURRENT value belongs to the branch we
    // just left — otherwise a new count would be started against a
    // location from the other branch, not merely displayed oddly.
    if (pickableLocations.length && (!newLoc || !pickableLocations.some(l => l.id === newLoc))) {
      // The person's own default when it's countable here — a store
      // manager's is the Store — rather than whichever came first.
      setNewLoc(startingDept(pickableLocations, staff, locations))
    }
  }, [pickableLocations, newLoc])

  const refresh = useCallback(() => {
    loadCounts(staff.branch_id)
      .then(c => { setCounts(c); setCountsErr(null) })
      .catch(e => setCountsErr(e.message || 'could not load'))
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

  // auditor correcting one line of a SUBMITTED count — different path
  // from setLine (which upserts via saveCountLine, draft-only). This
  // goes through the auditor RPC and flags the line as adjusted.
  // The reason for a line that differs. Saved as it is tapped, so a
  // half-finished count keeps what has been said about it.
  async function setReason(itemId, reason) {
    const countId = open.count.id
    setOpen(o => ({ ...o, lines: o.lines.map(l =>
      l.stock_item_id === itemId ? { ...l, variance_reason: reason } : l) }))
    const line = open.lines.find(l => l.stock_item_id === itemId)
    try {
      if (open.count.status === 'submitted' && canAdjust) {
        // A submitted count is only writable through the auditor RPC.
        if (line?.counted_qty === null || line?.counted_qty === undefined) return
        await auditorAdjustCountLine(countId, itemId, Number(line.counted_qty), reason)
      } else {
        await saveCountReason(countId, itemId, reason)
      }
    } catch (e) { toast('Could not save that reason: ' + e.message, 'error') }
  }

  async function adjustLine(line) {
    if (open.count.status !== 'submitted' || !canAdjust) return
    if (line.counted_qty === null || line.counted_qty === undefined) return
    const countId = open.count.id
    // The database refuses an adjustment nobody explained, so there is
    // no point sending one — say so here instead of showing its error.
    if (differs(line) && !hasReason(line)) {
      toast('Say why this differs from the book before changing it', 'error')
      return
    }
    try {
      await auditorAdjustCountLine(countId, line.stock_item_id, Number(line.counted_qty),
                                   (line.variance_reason || '').trim())
      setOpen(o => o?.count.id === countId ? { ...o, lines: o.lines.map(l =>
        l.stock_item_id === line.stock_item_id ? { ...l, auditor_adjusted: true, adjusted_by: staff.id } : l) } : o)
    } catch (e) { toast('Could not adjust: ' + e.message, 'error') }
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

  // Every line that differs must say why — checked here so it is caught
  // while the counter is still standing at the shelf, and again by the
  // database when the count posts, which is the rule that actually
  // holds (545).
  function unexplained() {
    return open.lines.filter(l => differs(l) && !hasReason(l))
  }

  async function doSubmit() {
    const missing = open.lines.filter(l => Number(l.system_qty) !== 0 && l.counted_qty === null).length
    if (missing > 0) {
      toast(`${missing} item${missing > 1 ? 's' : ''} with stock here still need a count entered`, 'error')
      return
    }
    const why = unexplained()
    if (why.length) {
      toast(`${why.length} line${why.length > 1 ? 's differ' : ' differs'} from the book with no reason given`, 'error')
      return
    }
    const odd = open.lines.filter(looksOff)
    if (odd.length) {
      const list = odd.slice(0, 8).map(l =>
        `${itemById[l.stock_item_id]?.name || '—'}: system ${l.system_qty}, you counted ${l.counted_qty}`).join('\n')
      if (!window.confirm(`These counts are far from what the system expects:\n\n${list}${odd.length > 8 ? `\n…and ${odd.length - 8} more` : ''}\n\nRecount them if unsure. Submit anyway?`)) return
    }
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
    const why = unexplained()
    if (why.length) {
      toast(`${why.length} line${why.length > 1 ? 's differ' : ' differs'} from the book with no reason given`, 'error')
      return
    }
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

  if (countsErr) {
    return (
      <div className="px-5">
        <Notice tone="problem" title="Counts could not be loaded" className="mt-4">
          <p>This does not mean there are none waiting. Tell the GM.</p>
          <p className="text-xs mt-2 break-words">{countsErr}</p>
        </Notice>
      </div>
    )
  }
  if (!counts) return <p className="px-5 text-dim">Loading…</p>
  // What is waiting on someone. A count sitting submitted is the only
  // thing on this page that needs doing, and it was a word on a row in
  // a list of forty.
  const nDraft = counts.filter(c => c.status === 'draft').length
  const nSubmitted = counts.filter(c => c.status === 'submitted').length
  const nVerified = counts.length - nDraft - nSubmitted
  const shownCounts = statusFilter === 'all' ? counts
    : counts.filter(c => c.status === statusFilter)

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
              onChange={e => {
                const v = e.target.value
                if (!v) return
                // max= is a hint the phone's picker may ignore — a stock
                // movement dated 27 days ahead got in that way on 1
                // October. The refusal is here as well.
                if (v > lagosToday()) {
                  setNewDate(lagosToday()); toast('That date has not happened yet', 'error'); return
                }
                setNewDate(v)
              }}
              className={`h-12 px-3 mb-2 rounded-xl bg-surface border tnum ${
                newDate !== lagosToday() ? 'border-amber text-amber' : 'border-line'}`} />
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

      {/* What is waiting, before the list of forty. */}
      <section className={`rounded-2xl border bg-surface p-4 mt-1 ${
        nSubmitted > 0 ? 'border-amber' : 'border-line'}`}>
        <div className="text-dim text-sm">Waiting for the auditor</div>
        <div className={`tnum text-3xl font-bold ${nSubmitted > 0 ? 'text-amber' : 'text-leaf'}`}>
          {nSubmitted}
        </div>
        <div className="text-dim text-sm mt-1">
          {nDraft} still being counted · {nVerified} verified
          {counts.length >= 40 && <span className="text-amber"> · newest 40 only</span>}
        </div>
      </section>

      <div className="flex gap-2 mt-3 mb-1">
        {[['all', 'All'], ['submitted', 'Waiting'], ['draft', 'Counting'], ['verified', 'Verified']]
          .map(([k, label]) => (
          <button key={k} onClick={() => setStatusFilter(k)}
            className={`flex-1 h-10 rounded-xl border text-sm font-semibold ${statusFilter === k
              ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      <ul className="divide-y divide-line/60">
        {shownCounts.map(c => (
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
        {!!counts.length && !shownCounts.length && (
          <li className="py-8 text-center text-dim">
            {statusFilter === 'submitted' ? 'Nothing is waiting for the auditor.'
              : statusFilter === 'draft' ? 'Nothing is part-counted.'
              : 'Nothing verified yet.'}
          </li>
        )}
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
                    <li key={l.stock_item_id} className="py-3 flex flex-wrap items-center gap-x-3">
                      <span className="flex-1 min-w-0 truncate">
                        {itemById[l.stock_item_id]?.name || '—'}
                      </span>
                      <span className="tnum text-dim w-12 text-right">{l.system_qty}</span>
                      {open.count.status === 'draft' ? (
                        <input type="number" inputMode="numeric"
                          value={l.counted_qty ?? ''} placeholder="—"
                          onChange={e => setLine(l.stock_item_id, e.target.value)}
                          className={`h-11 w-20 px-2 rounded-lg bg-surface border tnum text-center ${
                            looksOff(l) ? 'border-clay'
                            : l.pending ? 'border-amber'
                            : (Number(l.system_qty) !== 0 && l.counted_qty === null) ? 'border-clay'
                            : 'border-line'}`} />
                      ) : (open.count.status === 'submitted' && canAdjust) ? (
                        // auditor can correct a submitted figure before
                        // verifying — overwrites, flags the line as adjusted.
                        // onChange only touches local state (saveCountLine
                        // is draft-only); onBlur persists via the auditor RPC.
                        <input type="number" inputMode="numeric"
                          value={l.counted_qty ?? ''} placeholder="—"
                          onChange={e => {
                            const qty = e.target.value === '' ? null : Number(e.target.value)
                            setOpen(o => ({ ...o, lines: o.lines.map(x =>
                              x.stock_item_id === l.stock_item_id ? { ...x, counted_qty: qty } : x) }))
                          }}
                          onBlur={() => adjustLine(open.lines.find(x => x.stock_item_id === l.stock_item_id))}
                          className={`h-11 w-20 px-2 rounded-lg bg-surface border tnum text-center ${
                            l.auditor_adjusted ? 'border-amber' : 'border-line'}`} />
                      ) : (
                        <span className="tnum w-20 text-center">
                          {l.counted_qty ?? '—'}
                          {l.auditor_adjusted && <span className="text-amber text-xs block leading-none">adjusted</span>}
                        </span>
                      )}
                      <span className={`tnum w-12 text-right ${!diff ? 'text-dim'
                        : diff > 0 ? 'text-leaf' : 'text-clay'}`}>
                        {diff === null ? '' : diff > 0 ? `+${diff}` : diff}
                      </span>
                      {open.count.status === 'draft' && looksOff(l) && (
                        <p className="basis-full text-clay text-sm mt-1">
                          System expects {l.system_qty}, you typed {l.counted_qty}. Count again to be sure.
                        </p>
                      )}

                      {/* Only where there is something to explain. A
                          line that matches the book asks nothing —
                          demanding a reason fifty times is how you
                          train people to type rubbish on the one line
                          that mattered. */}
                      {differs(l) && (open.count.status === 'draft'
                        || (open.count.status === 'submitted' && canAdjust)) && (
                        <div className="basis-full mt-2">
                          <div className={`text-sm mb-1 ${hasReason(l) ? 'text-dim' : 'text-clay font-semibold'}`}>
                            {hasReason(l) ? 'Why it differs' : 'Say why it differs'}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {REASONS.map(r => (
                              <button key={r} onClick={() => setReason(l.stock_item_id, r)}
                                className={`h-9 px-3 rounded-full border text-sm ${
                                  (l.variance_reason || '') === r
                                    ? 'bg-raise border-amber text-amber font-bold'
                                    : 'border-line text-dim'}`}>
                                {r}
                              </button>
                            ))}
                            <button onClick={() => setReason(l.stock_item_id, REASONS.includes(l.variance_reason || '') ? '' : (l.variance_reason || ''))}
                              className={`h-9 px-3 rounded-full border text-sm ${
                                l.variance_reason !== null && l.variance_reason !== undefined
                                  && !REASONS.includes(l.variance_reason)
                                  ? 'bg-raise border-amber text-amber font-bold'
                                  : 'border-line text-dim'}`}>
                              Other
                            </button>
                          </div>
                          {l.variance_reason !== null && l.variance_reason !== undefined
                            && !REASONS.includes(l.variance_reason) && (
                            <input value={l.variance_reason || ''} autoFocus
                              placeholder="Say what happened"
                              onChange={e => setOpen(o => ({ ...o, lines: o.lines.map(x =>
                                x.stock_item_id === l.stock_item_id
                                  ? { ...x, variance_reason: e.target.value } : x) }))}
                              onBlur={e => setReason(l.stock_item_id, e.target.value.trim())}
                              className={`mt-2 h-11 w-full px-3 rounded-xl bg-surface border ${
                                hasReason(l) ? 'border-line' : 'border-clay'}`} />
                          )}
                        </div>
                      )}

                      {/* Verified counts keep the reason on show — a
                          reason nobody ever sees is a reason nobody
                          writes honestly. */}
                      {open.count.status === 'verified' && differs(l) && l.variance_reason && (
                        <p className="basis-full text-dim text-sm mt-1">{l.variance_reason}</p>
                      )}
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
            {open.count.status === 'submitted' && canVerifyThis && (
              <button onClick={doVerify} disabled={busy}
                className="w-full h-16 rounded-2xl bg-leaf text-bg text-xl font-bold disabled:opacity-40">
                {busy ? 'Verifying…' : 'Verify and post variances'}
              </button>
            )}
            {open.count.status === 'submitted' && !canVerifyThis && (
              <p className="text-center text-dim">
                {iAdjusted
                  ? 'You adjusted a line on this count, so someone else must verify it.'
                  : hasAdjusted
                    ? 'A line on this count was adjusted, so a GM or manager must verify it.'
                    : 'Only an auditor can verify this count.'}
              </p>
            )}
            {(
              (open.count.status === 'submitted' && canDelete)
              || (open.count.status === 'draft' && open.count.counted_by === staff.id)
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
