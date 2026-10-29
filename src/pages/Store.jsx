import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '../components/Toast'
import { lagosDaysAgo, lagosToday } from '../lib/format'
import FoldedDays from '../components/FoldedDays'
import { loadDepartmentSupplies, loadStockMap, loadPopular, loadDepartmentHistory,
         loadReceiveHistory, loadMoveHistory, loadConvertHistory } from '../lib/data'
import { supabase } from '../lib/supabase'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import ItemPicker from '../components/ItemPicker'
import { tracked } from '../lib/loadfail'

export default function Store({ boot }) {
  const { staff, allLocations } = boot
  const [kind, setKind] = useState('stock')       // stock | supplies
  const [deptSupplies, setDeptSupplies] = useState({})
  useEffect(() => {
    loadDepartmentSupplies(boot.staff.branch_id).then(setDeptSupplies).catch(() => {})
  }, [boot.staff.branch_id])
  const locations = allLocations
  const store = locations.find(l => l.is_store)
  // TWO lists, because "holds stock" and "receives nothing" are not the
  // same thing (25 October 2026).
  //
  // holds_stock says a place keeps SALE stock on a shelf. Reception does
  // not — nothing sits there to be sold, and offering it as a
  // destination is how five plates of groundnut came to be converted at
  // the front desk. But Reception does receive SUPPLIES: exercise books
  // went Store → Reception on 29 September and again on 17 October.
  //
  // Filtering one list for both would have quietly stopped the front
  // desk being given a notebook. Sale stock uses `departments`;
  // disbursing supplies uses `allDepartments`.
  const allDepartments = locations.filter(l => !l.is_store)
  const departments = allDepartments.filter(l => l.holds_stock !== false)
  const [date, setDate] = useState(lagosToday())
  const [receiver, setReceiver] = useState('')
  const toast = useToast()

  const [mode, setMode] = useState('receive')       // receive | disburse | move | convert
  // Where this mode may send things. Below `mode` deliberately: it
  // reads it, and a const read above its own declaration crashes the
  // whole page at render — check-tdz.mjs caught this one.
  const destinations = (kind === 'supplies' && mode === 'disburse') ? allDepartments : departments
  const [stockMap, setStockMap] = useState({})
  const [popular, setPopular] = useState({})
  const [picking, setPicking] = useState(false)
  const [lines, setLines] = useState([])            // staged, saved together — receive/disburse/move
  const [toDept, setToDept] = useState(departments[0]?.id)
  // supplies issued to a department are limited to that department's list
  const allowed = deptSupplies[toDept]
  const items = kind === 'supplies'
    ? (boot.supplyItems || []).filter(i => mode === 'disburse' && allowed ? allowed.has(i.id) : true)
    : boot.items
  const [fromDept, setFromDept] = useState(departments[1]?.id || departments[0]?.id)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  // Which days are open. null = untouched, so the newest day shows and
  // the rest stay shut. Reset whenever the history itself changes, or a
  // date left open under Receive would stay open under Convert, which is
  // a different list entirely.
  const [openHistoryDays, setOpenHistoryDays] = useState(null)

  // convert: one item becomes a different item, at a fixed ratio you
  // type each time (e.g. 2 bottles -> 10 plates) rather than a
  // permanently-stored recipe — simpler, and a bad ratio can't run
  // silently wrong forever if nothing remembers it automatically
  const [convertLoc, setConvertLoc] = useState(departments[0]?.id)
  const [convertFrom, setConvertFrom] = useState(null)   // { item, qty }
  const [convertTo, setConvertTo] = useState(null)       // { item, qty }
  const [convertPicking, setConvertPicking] = useState(null) // 'from' | 'to' | null

  // Reset department pickers on branch switch (GM/admin) — otherwise
  // the old branch's department ids stay selected here, matching no
  // chip and pointing a transfer/conversion at a department that
  // doesn't exist on the branch now being viewed.
  useEffect(() => {
    const valid = (id) => departments.some(d => d.id === id)
    // toDept is checked against destinations: in supplies-disburse it is
    // allowed to be a place that keeps no sale stock, and resetting it
    // here would throw the choice away the moment it was made.
    if (!destinations.some(d => d.id === toDept)) setToDept(destinations[0]?.id)
    if (!valid(fromDept)) setFromDept(departments[1]?.id || departments[0]?.id)
    if (!valid(convertLoc)) setConvertLoc(departments[0]?.id)
  }, [staff.branch_id])

  const refresh = useCallback(() => {
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
    loadStockMap(staff.branch_id).then(setStockMap).catch(console.error)
    loadPopular(staff.branch_id, since).then(setPopular).catch(console.error)
  }, [staff.branch_id])
  useEffect(refresh, [refresh])

  // history for whichever mode is active — receive (into store),
  // issue (to a dept), move (from a dept), convert (at a dept)
  const reloadHistory = useCallback((clearFirst = true) => {
    if (clearFirst) setHistory(null)
    setOpenHistoryDays(null)
    let p
    if (mode === 'receive' && store?.id) p = loadReceiveHistory(staff.branch_id, store.id)
    else if (mode === 'disburse' && toDept) p = loadDepartmentHistory(staff.branch_id, toDept)
    else if (mode === 'move' && fromDept) p = loadMoveHistory(staff.branch_id, fromDept)
    else if (mode === 'convert' && convertLoc) p = loadConvertHistory(staff.branch_id, convertLoc)
    if (p) tracked('Store history', p).then(setHistory).catch(() => setHistory([]))
    else setHistory([])
  }, [staff.branch_id, mode, toDept, fromDept, convertLoc, store?.id])
  useEffect(() => reloadHistory(true), [reloadHistory])

  // stock at any location, not just the store — needed once "move"
  // draws from a department instead of the store
  const qtyAt = useMemo(
    () => (itemId, locId) => stockMap[`${itemId}:${locId}`] ?? 0, [stockMap])

  const sourceLocationId = mode === 'receive' ? null
    : mode === 'move' ? fromDept
    : store?.id  // disburse always draws from the store

  // Received in crates, held in bottles (Chris, 25 October 2026; 575).
  //
  // Only on the way IN, and only for an item whose pack is a counting
  // unit. An item with a piece_item_id is a pack that is itself stock —
  // a bottle of groundnut — and five of those received are five bottles,
  // not twenty-five plates. Converting it is a separate act, on the
  // Convert tab, when someone actually opens the bottle.
  const packable = (item) => mode === 'receive'
    && Number(item?.pack_size) > 1 && !item?.piece_item_id
  // What goes on the book: packs multiply, singles do not.
  const piecesOf = (l) => (l.inPacks && packable(l.item))
    ? l.qty * Number(l.item.pack_size) : l.qty

  function addLine(item) {
    setPicking(false)
    // Defaults to packs where the item has a pack size, because that is
    // how the goods arrive. One tap switches it back for the odd loose
    // bottle.
    setLines(l => l.some(x => x.item.id === item.id) ? l
      : [...l, { item, qty: 1, inPacks: Number(item?.pack_size) > 1 && !item?.piece_item_id }])
  }
  const setQty = (id, q) => setLines(l => l.map(x => x.item.id === id ? { ...x, qty: Math.max(1, q) } : x))
  const setInPacks = (id, v) => setLines(l => l.map(x => x.item.id === id ? { ...x, inPacks: v } : x))
  const drop = (id) => setLines(l => l.filter(x => x.item.id !== id))

  async function save() {
    if (!lines.length) return
    // 19 October 2026. A restock of 25 bags of rice was keyed on 1
    // October carrying 28 October — a month typed wrong. max= on the
    // input is a hint the browser may or may not honour, and the date
    // picker on a phone did not. The book counted those bags from the
    // day it was typed, because v_stock_on_hand pays no attention to
    // dates at all. So the refusal lives here, where it cannot be
    // walked around.
    if (date > lagosToday()) {
      toast('That date has not happened yet. Stock cannot be recorded ahead of today.', 'error')
      return
    }
    setBusy(true)
    try {
      const dept = allDepartments.find(d => d.id === toDept)
      const sup = kind === 'supplies'
      if (sup && mode === 'disburse') {
        if (!receiver.trim()) { toast('Say who is receiving it', 'error'); setBusy(false); return }
      }
      if (!sup && mode === 'disburse' && ['housekeeping', 'laundry', 'others'].includes(dept?.slug) && !receiver.trim()) {
        toast('Say who is receiving it', 'error'); setBusy(false); return
      }
      const issues = mode === 'disburse' && !sup && dept?.consumes_on_issue
      const movementType = mode === 'receive' ? 'restock'
        : mode === 'move' ? 'transfer'
        : (issues ? 'issue' : 'transfer')
      const fromLoc = mode === 'receive' ? null
        : mode === 'move' ? fromDept
        : store.id
      const toLoc = mode === 'receive' ? store.id : toDept
      const noteWhat = sup && mode === 'disburse' ? `supplies to ${dept?.name}`
        : mode === 'receive' ? (sup ? 'supplies received into store' : 'received into store')
        : mode === 'move' ? `moved from ${allDepartments.find(d => d.id === fromDept)?.name} to ${dept?.name}`
        : `${issues ? 'issued to' : 'to'} ${dept?.name}`
      const rows = lines.map(l => ({
        branch_id: staff.branch_id,
        stock_item_id: l.item.id,
        movement_type: movementType,
        from_location: fromLoc,
        to_location: toLoc,
        qty: piecesOf(l),
        business_date: date,
        received_by: mode !== 'receive' ? (receiver.trim() || null) : null,
        occurred_at: new Date().toISOString(),
        recorded_by: staff.id,
        is_migrated: false,
        // The pack arithmetic goes in the note as well as the figure, so
        // a count that disagrees later can be read back to what was
        // actually carried in — "60 bottles" alone cannot tell you
        // whether five crates or six were delivered.
        note: (l.inPacks && packable(l.item))
          ? `${noteWhat} — ${l.qty} ${l.item.pack_label}${l.qty === 1 ? '' : 's'} × ${Number(l.item.pack_size)}`
          : noteWhat,
      }))
      try {
        const { error } = await supabase.from('stock_movements').insert(rows)
        if (error) throw error
        toast(`${rows.length} item${rows.length > 1 ? 's' : ''} ${mode === 'receive' ? 'received' : mode === 'move' ? 'moved' : 'disbursed'}`, 'success')
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'movements', payload: { rows } })
        toast('No connection — saved and will send when you are back online')
      }
      setLines([]); setReceiver(''); refresh(); flush()
      reloadHistory(false)
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function saveConvert() {
    if (date > lagosToday()) {
      toast('That date has not happened yet. Stock cannot be recorded ahead of today.', 'error')
      return
    }
    if (!convertFrom?.item || !convertTo?.item || !convertFrom.qty || !convertTo.qty) return
    if (convertFrom.item.id === convertTo.item.id) {
      toast('Pick two different items — this converts one into another', 'error'); return
    }
    setBusy(true)
    const noteText = `Converted ${convertFrom.qty} × ${convertFrom.item.name} into ${convertTo.qty} × ${convertTo.item.name}`
    const rows = [
      { branch_id: staff.branch_id, stock_item_id: convertFrom.item.id, movement_type: 'conversion',
        from_location: convertLoc, to_location: null, qty: convertFrom.qty,
        business_date: date, occurred_at: new Date().toISOString(), recorded_by: staff.id,
        is_migrated: false, note: noteText },
      { branch_id: staff.branch_id, stock_item_id: convertTo.item.id, movement_type: 'conversion',
        from_location: null, to_location: convertLoc, qty: convertTo.qty,
        business_date: date, occurred_at: new Date().toISOString(), recorded_by: staff.id,
        is_migrated: false, note: noteText },
    ]
    try {
      try {
        const { error } = await supabase.from('stock_movements').insert(rows)
        if (error) throw error
        toast('Converted', 'success')
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'movements', payload: { rows } })
        toast('No connection — saved and will send when you are back online')
      }
      setConvertFrom(null); setConvertTo(null); refresh(); flush(); reloadHistory(false)
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  const overdrawn = mode !== 'receive' && mode !== 'convert'
    && lines.some(l => l.qty > qtyAt(l.item.id, sourceLocationId))
  const convertShort = convertFrom?.item
    && convertFrom.qty > qtyAt(convertFrom.item.id, convertLoc)

  const MODES = kind === 'supplies'
    ? [['receive', 'Receive (IN)'], ['disburse', 'Issue (OUT)']]
    : [['receive', 'Receive (IN)'], ['disburse', 'Issue (OUT)'],
       ['move', 'Move Between Depts'], ['convert', 'Convert']]
  // Sale stock and supplies are two tabs, and a row belongs to one of
  // them by its item's ID. It used to be matched by NAME, which would
  // have sent an item's whole history to the other tab the day someone
  // renamed it, and collided outright on two items sharing a name
  // across the two lists (25 October 2026).
  const supplyIds = useMemo(
    () => new Set((boot.supplyItems || []).map(i => i.id)), [boot.supplyItems])
  const shownHistory = history && history.filter(h =>
    (kind === 'supplies') === supplyIds.has(h.stock_item_id))

  // ── History, folded by the day it happened ────────────────────────
  // Sixty days of a working store is a long scroll to reach one entry.
  const historyByDay = useMemo(() => {
    const m = new Map()
    for (const h of (shownHistory || [])) {
      if (!m.has(h.business_date)) m.set(h.business_date, [])
      m.get(h.business_date).push(h)
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [shownHistory])
  const firstHistoryDay = historyByDay.length ? historyByDay[0][0] : null
  const histDayOpen = (d) => openHistoryDays ? openHistoryDays.has(d) : d === firstHistoryDay
  const toggleHistoryDay = (d) => setOpenHistoryDays(cur => {
    const next = cur ? new Set(cur) : new Set(firstHistoryDay ? [firstHistoryDay] : [])
    if (next.has(d)) next.delete(d); else next.add(d)
    return next
  })

  // The pack a receive was keyed in, pulled back out of its own note.
  // Only the suffix save() writes, so anything else in a note is left
  // alone and an older row simply has none.
  const packNote = (h) => {
    const m = /—\s*(\d+\s+\S+\s+×\s+\d+)\s*$/.exec(h?.note || '')
    return m ? m[1] : ''
  }

  const offToday = date !== lagosToday()
  const dayLong = (d) => new Date(d + 'T12:00:00')
    .toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="px-5">
      {/* The day this will be recorded on, pinned, in the same words and
          the same two tones as the Sales page (19 October 2026). The
          date box sits halfway down this form, below the mode chips and
          the department chips, and nothing above it ever said which day
          was about to be written. */}
      {offToday && (
        <div className={`sticky top-0 z-20 -mx-5 px-5 py-2 font-bold text-sm text-center ${
          date < lagosDaysAgo(1) ? 'bg-amber text-bg' : 'bg-raise text-amber border-b border-amber/40'}`}>
          Recording for {dayLong(date)}
          {date < lagosDaysAgo(1) ? ' — not today' : ' — yesterday'}
        </div>
      )}
      <div className="flex gap-2 pt-2">
        {[['stock', 'Stock'], ['supplies', 'Supplies']].map(([k, label]) => (
          <button key={k} onClick={() => { setKind(k); setMode('receive'); setLines([]) }}
            className={`flex-1 h-11 rounded-xl border font-bold ${kind === k
              ? 'bg-amber/20 text-amber border-amber' : 'border-line text-dim'}`}>{label}</button>
        ))}
      </div>
      <div className="flex gap-2 py-2 overflow-x-auto -mx-1 px-1">
        {MODES.map(([k, label]) => (
          <button key={k} onClick={() => { setMode(k); setLines([]) }}
            className={`shrink-0 h-12 px-4 rounded-xl border font-bold ${mode === k
              ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      <p className="text-dim text-sm">
        {mode === 'receive' && 'Stock arriving from suppliers, into the store.'}
        {mode === 'disburse' && (kind === 'supplies'
          ? 'Supplies handed to a department. The department holds them and records each use.'
          : 'Stock leaving the store for a department.')}
        {mode === 'move' && 'Stock moving directly between two departments — never touches the store.'}
        {mode === 'convert' && 'One item becomes a different item — e.g. bottles of groundnut repacked into plates.'}
      </p>
      {mode === 'disburse' && kind === 'stock' && allDepartments.find(d => d.id === toDept)?.consumes_on_issue && (
        <p className="text-dim text-sm mt-2">
          {allDepartments.find(d => d.id === toDept)?.name} is a consuming department —
          this stock is used up on issue, not held as a balance there.
        </p>
      )}

      {mode === 'disburse' && kind === 'supplies' && allowed && (
        <p className="text-dim text-sm mt-2">
          Only the supplies on {allDepartments.find(d => d.id === toDept)?.name}'s list are offered.
        </p>
      )}

      {mode === 'disburse' && (
        <div className="mt-4">
          <div className="text-dim mb-2">Issue to (required)</div>
          {/* destinations, not departments: supplies go anywhere,
              sale stock only where stock is kept (25 October 2026). */}
          <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
            {destinations.map(d => (
              <button key={d.id} onClick={() => setToDept(d.id)}
                className={`shrink-0 h-11 px-4 rounded-full border ${d.id === toDept
                  ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'move' && (
        <div className="mt-4 space-y-3">
          <div>
            <div className="text-dim mb-2">From</div>
            <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
              {departments.map(d => (
                <button key={d.id} onClick={() => { setFromDept(d.id); setLines([]) }}
                  className={`shrink-0 h-11 px-4 rounded-full border ${d.id === fromDept
                    ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-dim mb-2">To</div>
            <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
              {departments.filter(d => d.id !== fromDept).map(d => (
                <button key={d.id} onClick={() => setToDept(d.id)}
                  className={`shrink-0 h-11 px-4 rounded-full border ${d.id === toDept
                    ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          {fromDept === toDept && (
            <p className="text-clay text-sm">Pick two different departments.</p>
          )}
        </div>
      )}

      {mode !== 'convert' && (
        <div className="mt-4 flex gap-2">
          <div className="flex-1">
            <div className="text-dim text-sm mb-1">
              {mode === 'receive' ? 'Date received' : 'Date'}
            </div>
            <input type="date" value={date} max={lagosToday()}
              onChange={e => {
                const v = e.target.value
                if (!v) return
                if (v > lagosToday()) {
                  setDate(lagosToday())
                  toast('That date has not happened yet', 'error')
                  return
                }
                setDate(v)
              }}
              className={`h-12 px-3 rounded-xl bg-surface border tnum ${
                date !== lagosToday() ? 'border-amber text-amber' : 'border-line'}`} />
          </div>
          {mode !== 'receive' && (
            <div className="flex-1">
              <div className="text-dim text-sm mb-1">Receiver</div>
              <input value={receiver} onChange={e => setReceiver(e.target.value)}
                placeholder="Who collected it"
                className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
            </div>
          )}
        </div>
      )}

      {mode !== 'convert' && (
        <button onClick={() => setPicking(true)}
          disabled={mode === 'move' && fromDept === toDept}
          className="mt-4 w-full h-14 rounded-2xl border-2 border-amber text-amber text-lg font-bold disabled:opacity-40">
          {mode === 'receive' ? (kind === 'supplies' ? '+ Receive Supplies' : '+ Receive Stock') : mode === 'move' ? '+ Add Item to Move' : '+ Issue To'}
        </button>
      )}

      {(() => {
        // history section for the active mode; only shows once the
        // relevant selection is made (a dept for issue/move/convert,
        // always for receive since it targets the store)
        const active =
          mode === 'receive' ? { title: 'Received into store', empty: 'Nothing received yet.' }
          : mode === 'disburse' && toDept
            ? { title: `Issued — ${allDepartments.find(d => d.id === toDept)?.name || ''}`,
                empty: 'Nothing issued to this department yet.' }
          : mode === 'move' && fromDept
            ? { title: `Moved from ${allDepartments.find(d => d.id === fromDept)?.name || ''}`,
                empty: 'Nothing moved from this department yet.' }
          : mode === 'convert' && convertLoc
            ? { title: `Conversions — ${departments.find(d => d.id === convertLoc)?.name || ''}`,
                empty: 'Nothing converted here yet.' }
          : null
        if (!active) return null
        return (
          <div className="mt-4">
            <button onClick={() => setShowHistory(s => !s)}
              className="w-full flex items-center justify-between text-left py-2">
              <span className="font-semibold">History — {active.title}</span>
              <span className="text-dim text-sm">{showHistory ? 'Hide' : 'Show'}</span>
            </button>
            {showHistory && (
              <div className="mb-2">
                {history === null && (
                  <p className="py-6 text-dim text-center rounded-2xl border border-line bg-surface">Loading…</p>
                )}
                {shownHistory && !shownHistory.length && (
                  <p className="py-6 text-dim text-center rounded-2xl border border-line bg-surface">{active.empty}</p>
                )}
                {/* Finished months and years fold away (579). */}
                <FoldedDays groups={historyByDay} today={lagosToday()}
                  summary={(items) => (
                    <span className="tnum font-bold">
                      {items.reduce((t, r) => t + Number(r.qty || 0), 0)}
                    </span>
                  )}
                  renderDay={(day, rows) => {
                  const open = histDayOpen(day)
                  const total = rows.reduce((t, r) => t + Number(r.qty || 0), 0)
                  return (
                    <section key={day} className="mt-2 rounded-2xl border border-line bg-surface">
                      <button type="button" onClick={() => toggleHistoryDay(day)} aria-expanded={open}
                        className="w-full px-4 py-3 flex items-baseline justify-between gap-3 text-left">
                        <span className="min-w-0">
                          <span className="font-semibold">{dayLong(day)}</span>
                          <span className="text-dim text-sm block tnum">
                            {rows.length} entr{rows.length === 1 ? 'y' : 'ies'} · {total} in total
                          </span>
                        </span>
                        <svg viewBox="0 0 20 20" aria-hidden="true"
                          className={`w-4 h-4 shrink-0 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      {open && (
                        <ul className="divide-y divide-line/60 border-t border-line px-4">
                          {rows.map((h, i) => {
                            const pack = packNote(h)
                            return (
                              <li key={i} className="py-3">
                                <div className="flex items-baseline gap-3">
                                  <span className="flex-1 min-w-0 font-semibold break-words">
                                    {h.stock_items?.name || '—'}
                                  </span>
                                  <span className="tnum font-semibold shrink-0">{h.qty}</span>
                                </div>
                                {/* No date on the row: the day is the heading above. */}
                                <div className="text-dim text-sm mt-0.5 break-words">
                                  {mode === 'convert'
                                    ? (h.note || `${h.qty} produced`)
                                    : mode === 'receive'
                                    ? `received${h.received_by ? ` from ${h.received_by}` : ''}`
                                    : mode === 'move'
                                    // Where it WENT. A list of what left a
                                    // department that cannot say where to is
                                    // half a record (25 October 2026).
                                    ? `moved to ${allDepartments.find(d => d.id === h.to_location)?.name || 'somewhere'}${h.received_by ? ` · received by ${h.received_by}` : ''}`
                                    : `received${h.received_by ? ` by ${h.received_by}` : ''}`}
                                  {h.staff?.full_name ? ` · by ${h.staff.full_name}` : ''}
                                </div>
                                {/* What was actually carried in, where it was
                                    keyed in packs — "60" alone cannot tell you
                                    whether five crates came or six. */}
                                {pack && (
                                  <div className="text-leaf text-sm tnum font-semibold">{pack}</div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </section>
                  )
                }} />
              </div>
            )}
          </div>
        )
      })()}


      {mode !== 'convert' && (
        <ul className="mt-4 divide-y divide-line/60">
          {lines.map(l => {
            const avail = qtyAt(l.item.id, sourceLocationId)
            const short = mode !== 'receive' && l.qty > avail
            return (
              <li key={l.item.id} className="py-3">
                <div className="flex items-center gap-3">
                  <span className="flex-1 min-w-0 truncate font-semibold">{l.item.name}</span>
                  <button onClick={() => drop(l.item.id)} className="text-dim px-2">Remove</button>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button onClick={() => setQty(l.item.id, l.qty - 1)}
                    className="h-12 w-12 rounded-xl bg-surface border border-line text-2xl font-bold">−</button>
                  <input type="number" inputMode="numeric" value={l.qty}
                    onChange={e => setQty(l.item.id, Number(e.target.value))}
                    className="h-12 w-20 px-3 rounded-xl bg-surface border border-line tnum text-center" />
                  <button onClick={() => setQty(l.item.id, l.qty + 1)}
                    className="h-12 w-12 rounded-xl bg-surface border border-line text-2xl font-bold">+</button>
                  <span className={`flex-1 text-right tnum ${short ? 'text-clay' : 'text-dim'}`}>
                    {mode === 'receive' ? '' : `${avail} here`}
                  </span>
                </div>
                {/* The arithmetic, printed every time. A stored pack size
                    that nobody ever sees is the thing that runs silently
                    wrong for months — this is what makes a wrong one
                    obvious on the first use. */}
                {packable(l.item) && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <div className="flex gap-1 rounded-xl border border-line overflow-hidden">
                      {[true, false].map(v => (
                        <button key={String(v)} onClick={() => setInPacks(l.item.id, v)}
                          className={`h-10 px-3 text-sm font-semibold ${l.inPacks === v
                            ? 'bg-raise text-amber' : 'text-dim'}`}>
                          {v ? `${l.item.pack_label}s` : 'singles'}
                        </button>
                      ))}
                    </div>
                    <span className="text-sm tnum text-leaf font-semibold">
                      {l.inPacks
                        ? `${l.qty} × ${Number(l.item.pack_size)} = ${piecesOf(l)} into the store`
                        : `${l.qty} into the store`}
                    </span>
                  </div>
                )}
              </li>
            )
          })}
          {!lines.length && <li className="py-6 text-dim">Nothing added yet.</li>}
        </ul>
      )}

      {mode !== 'convert' && !!lines.length && (
        <div className="sticky bottom-20 mt-4 pb-2">
          {overdrawn && <p className="text-clay mb-2">More than is here — check the count first.</p>}
          {mode !== 'receive' && !receiver.trim() && (
            <p className="text-dim text-sm mb-2">Add a receiver so the handover is on record.</p>
          )}
          <button onClick={save} disabled={busy || (mode === 'move' && fromDept === toDept) || (kind === 'supplies' && mode === 'disburse' && !receiver.trim())}
            className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : mode === 'receive' ? 'Save delivery' : mode === 'move' ? 'Save move' : 'Issue stock'}
          </button>
        </div>
      )}

      {mode === 'convert' && (
        <div className="mt-4 space-y-4">
          <div>
            <div className="text-dim mb-2">At which department</div>
            <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
              {departments.map(d => (
                <button key={d.id} onClick={() => setConvertLoc(d.id)}
                  className={`shrink-0 h-11 px-4 rounded-full border ${d.id === convertLoc
                    ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim text-sm mb-2">Using up (the item being broken down)</div>
            {convertFrom?.item ? (
              <div className="flex items-center gap-3">
                <span className="flex-1 font-semibold">{convertFrom.item.name}</span>
                <button onClick={() => setConvertFrom(null)} className="text-dim text-sm">Change</button>
              </div>
            ) : (
              <button onClick={() => setConvertPicking('from')}
                className="w-full h-12 rounded-xl border border-line text-dim">Pick item</button>
            )}
            {convertFrom?.item && (
              <div className="mt-3 flex items-center gap-3">
                <button onClick={() => setConvertFrom(c => ({ ...c, qty: Math.max(1, (c.qty || 1) - 1) }))}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">−</button>
                <input type="number" inputMode="numeric" value={convertFrom.qty ?? 1}
                  onChange={e => setConvertFrom(c => {
                    const qty = Math.max(1, Number(e.target.value))
                    // Two bottles is ten plates. Only follows along while
                    // the other side still matches the recorded ratio, so
                    // a hand-typed figure is never overwritten.
                    const per = Number(c.item?.pack_size) || 0
                    if (per > 1 && c.item?.piece_item_id
                        && convertTo && Number(convertTo.qty) === (c.qty || 1) * per) {
                      setConvertTo(t => ({ ...t, qty: qty * per }))
                    }
                    return { ...c, qty }
                  })}
                  className="h-11 w-16 px-2 rounded-xl bg-raise border border-line tnum text-center" />
                <button onClick={() => setConvertFrom(c => ({ ...c, qty: (c.qty || 1) + 1 }))}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">+</button>
                <span className={`flex-1 text-right tnum text-sm ${convertShort ? 'text-clay' : 'text-dim'}`}>
                  {qtyAt(convertFrom.item.id, convertLoc)} here
                </span>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-amber bg-surface p-4">
            <div className="text-dim text-sm mb-2">Becomes (the item produced)</div>
            {convertTo?.item ? (
              <div className="flex items-center gap-3">
                <span className="flex-1 font-semibold">{convertTo.item.name}</span>
                <button onClick={() => setConvertTo(null)} className="text-dim text-sm">Change</button>
              </div>
            ) : (
              <button onClick={() => setConvertPicking('to')}
                className="w-full h-12 rounded-xl border border-amber text-amber">Pick item</button>
            )}
            {convertTo?.item && (
              <div className="mt-3 flex items-center gap-3">
                <button onClick={() => setConvertTo(c => ({ ...c, qty: Math.max(1, (c.qty || 1) - 1) }))}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">−</button>
                <input type="number" inputMode="numeric" value={convertTo.qty ?? 1}
                  onChange={e => setConvertTo(c => ({ ...c, qty: Math.max(1, Number(e.target.value)) }))}
                  className="h-11 w-16 px-2 rounded-xl bg-raise border border-line tnum text-center" />
                <button onClick={() => setConvertTo(c => ({ ...c, qty: (c.qty || 1) + 1 }))}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">+</button>
              </div>
            )}
          </div>

          {convertShort && (
            <p className="text-clay text-sm">More than is here — check the count first.</p>
          )}

          {convertFrom?.item && convertTo?.item && (
            <button onClick={saveConvert} disabled={busy}
              className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Saving…'
                : `Convert ${convertFrom.qty || 1} × ${convertFrom.item.name} → ${convertTo.qty || 1} × ${convertTo.item.name}`}
            </button>
          )}
        </div>
      )}

      {picking && (
        <ItemPicker items={items} stockMap={stockMap} locationId={sourceLocationId}
          popular={popular} onPick={addLine} onClose={() => setPicking(false)} />
      )}

      {convertPicking && (
        <ItemPicker items={items} stockMap={stockMap} locationId={convertLoc}
          popular={popular}
          onPick={item => {
            if (convertPicking === 'from') {
              setConvertFrom({ item, qty: 1 })
              // If this item is recorded as breaking down into another —
              // a bottle of groundnut into plates (575) — fill the other
              // side in rather than making someone retype a ratio they
              // already told the app once. Still shown, still editable:
              // the day a bottle yields four plates instead of five, the
              // person doing it is the one who should say so.
              const piece = item?.piece_item_id
                ? [...(boot.items || []), ...(boot.supplyItems || [])]
                    .find(i => i.id === item.piece_item_id) : null
              if (piece) setConvertTo({ item: piece, qty: Number(item.pack_size) || 1 })
            } else setConvertTo({ item, qty: 1 })
            setConvertPicking(null)
          }}
          onClose={() => setConvertPicking(null)} />
      )}
    </div>
  )
}
