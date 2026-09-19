import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '../components/Toast'
import { naira, lagosToday } from '../lib/format'
import { loadStockMap, loadPopular, loadDepartmentHistory,
         loadReceiveHistory, loadMoveHistory, loadConvertHistory } from '../lib/data'
import { supabase } from '../lib/supabase'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import ItemPicker from '../components/ItemPicker'

export default function Store({ boot }) {
  const { staff, allLocations, items } = boot
  const locations = allLocations
  const store = locations.find(l => l.is_store)
  const departments = locations.filter(l => !l.is_store)
  const [date, setDate] = useState(lagosToday())
  const [receiver, setReceiver] = useState('')
  const toast = useToast()

  const [mode, setMode] = useState('receive')       // receive | disburse | move | convert
  const [stockMap, setStockMap] = useState({})
  const [popular, setPopular] = useState({})
  const [picking, setPicking] = useState(false)
  const [lines, setLines] = useState([])            // staged, saved together — receive/disburse/move
  const [toDept, setToDept] = useState(departments[0]?.id)
  const [fromDept, setFromDept] = useState(departments[1]?.id || departments[0]?.id)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState(null)
  const [showHistory, setShowHistory] = useState(false)

  // convert: one item becomes a different item, at a fixed ratio you
  // type each time (e.g. 2 bottles -> 10 plates) rather than a
  // permanently-stored recipe — simpler, and a bad ratio can't run
  // silently wrong forever if nothing remembers it automatically
  const [convertLoc, setConvertLoc] = useState(departments[0]?.id)
  const [convertFrom, setConvertFrom] = useState(null)   // { item, qty }
  const [convertTo, setConvertTo] = useState(null)       // { item, qty }
  const [convertPicking, setConvertPicking] = useState(null) // 'from' | 'to' | null

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
    let p
    if (mode === 'receive' && store?.id) p = loadReceiveHistory(staff.branch_id, store.id)
    else if (mode === 'disburse' && toDept) p = loadDepartmentHistory(staff.branch_id, toDept)
    else if (mode === 'move' && fromDept) p = loadMoveHistory(staff.branch_id, fromDept)
    else if (mode === 'convert' && convertLoc) p = loadConvertHistory(staff.branch_id, convertLoc)
    if (p) p.then(setHistory).catch(() => setHistory([]))
    else setHistory([])
  }, [staff.branch_id, mode, toDept, fromDept, convertLoc, store?.id])
  useEffect(() => reloadHistory(true), [reloadHistory])

  // stock at any location, not just the store — needed once "move"
  // draws from a department instead of the store
  const qtyAt = useMemo(
    () => (itemId, locId) => stockMap[`${itemId}:${locId}`] ?? 0, [stockMap])
  const storeQty = (id) => qtyAt(id, store?.id)

  const sourceLocationId = mode === 'receive' ? null
    : mode === 'move' ? fromDept
    : store?.id  // disburse always draws from the store

  function addLine(item) {
    setPicking(false)
    setLines(l => l.some(x => x.item.id === item.id) ? l
      : [...l, { item, qty: 1 }])
  }
  const setQty = (id, q) => setLines(l => l.map(x => x.item.id === id ? { ...x, qty: Math.max(1, q) } : x))
  const drop = (id) => setLines(l => l.filter(x => x.item.id !== id))

  async function save() {
    if (!lines.length) return
    setBusy(true)
    try {
      const dept = departments.find(d => d.id === toDept)
      const issues = mode === 'disburse' && dept?.consumes_on_issue
      const movementType = mode === 'receive' ? 'restock'
        : mode === 'move' ? 'transfer'
        : (issues ? 'issue' : 'transfer')
      const fromLoc = mode === 'receive' ? null
        : mode === 'move' ? fromDept
        : store.id
      const toLoc = mode === 'receive' ? store.id : toDept
      const noteWhat = mode === 'receive' ? 'received into store'
        : mode === 'move' ? `moved from ${departments.find(d => d.id === fromDept)?.name} to ${dept?.name}`
        : `${issues ? 'issued to' : 'to'} ${dept?.name}`
      const rows = lines.map(l => ({
        branch_id: staff.branch_id,
        stock_item_id: l.item.id,
        movement_type: movementType,
        from_location: fromLoc,
        to_location: toLoc,
        qty: l.qty,
        business_date: date,
        received_by: mode !== 'receive' ? (receiver.trim() || null) : null,
        occurred_at: new Date().toISOString(),
        recorded_by: staff.id,
        is_migrated: false,
        note: noteWhat,
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

  const MODES = [
    ['receive', 'Receive (IN)'],
    ['disburse', 'Issue (OUT)'],
    ['move', 'Move Between Depts'],
    ['convert', 'Convert'],
  ]

  return (
    <div className="px-5">
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
        {mode === 'disburse' && 'Stock leaving the store for a department.'}
        {mode === 'move' && 'Stock moving directly between two departments — never touches the store.'}
        {mode === 'convert' && 'One item becomes a different item — e.g. bottles of groundnut repacked into plates.'}
      </p>
      {mode === 'disburse' && departments.find(d => d.id === toDept)?.consumes_on_issue && (
        <p className="text-dim text-sm mt-2">
          {departments.find(d => d.id === toDept)?.name} is a consuming department —
          this stock is used up on issue, not held as a balance there.
        </p>
      )}

      {mode === 'disburse' && (
        <div className="mt-4">
          <div className="text-dim mb-2">Issue to (required)</div>
          <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
            {departments.map(d => (
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
              onChange={e => setDate(e.target.value)}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line tnum" />
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
          {mode === 'receive' ? '+ Receive Stock' : mode === 'move' ? '+ Add Item to Move' : '+ Issue To'}
        </button>
      )}

      {(() => {
        // history section for the active mode; only shows once the
        // relevant selection is made (a dept for issue/move/convert,
        // always for receive since it targets the store)
        const active =
          mode === 'receive' ? { title: 'Received into store', empty: 'Nothing received yet.' }
          : mode === 'disburse' && toDept
            ? { title: `Issued — ${departments.find(d => d.id === toDept)?.name || ''}`,
                empty: 'Nothing issued to this department yet.' }
          : mode === 'move' && fromDept
            ? { title: `Moved from ${departments.find(d => d.id === fromDept)?.name || ''}`,
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
              <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4 mb-2">
                {(history || []).map((h, i) => (
                  <li key={i} className="py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex-1 min-w-0 truncate font-semibold">
                        {h.stock_items?.name || '—'}
                      </span>
                      <span className="tnum text-dim text-sm">{h.business_date}</span>
                    </div>
                    <div className="text-dim text-sm mt-0.5">
                      {mode === 'convert'
                        ? (h.note || `${h.qty} produced`)
                        : mode === 'receive'
                        ? `${h.qty} received${h.received_by ? ` from ${h.received_by}` : ''}`
                        : mode === 'move'
                        ? `${h.qty} moved${h.received_by ? ` · received by ${h.received_by}` : ''}`
                        : `${h.qty} received${h.received_by ? ` by ${h.received_by}` : ''}`}
                      {h.staff?.full_name ? ` · by ${h.staff.full_name}` : ''}
                    </div>
                  </li>
                ))}
                {history === null && <li className="py-6 text-dim text-center">Loading…</li>}
                {history && !history.length && (
                  <li className="py-6 text-dim text-center">{active.empty}</li>
                )}
              </ul>
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
          <button onClick={save} disabled={busy || (mode === 'move' && fromDept === toDept)}
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
                  onChange={e => setConvertFrom(c => ({ ...c, qty: Math.max(1, Number(e.target.value)) }))}
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
            if (convertPicking === 'from') setConvertFrom({ item, qty: 1 })
            else setConvertTo({ item, qty: 1 })
            setConvertPicking(null)
          }}
          onClose={() => setConvertPicking(null)} />
      )}
    </div>
  )
}
