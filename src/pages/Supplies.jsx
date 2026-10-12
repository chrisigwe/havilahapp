import { useEffect, useMemo, useState } from 'react'
import { loadStockMap, loadSuppliesUse, recordSuppliesUse, voidSuppliesUse,
         loadDepartmentSupplies, setDepartmentSupply, returnSuppliesToStore } from '../lib/data'
import { lagosDaysAgo } from '../lib/format'
import { useToast } from '../components/Toast'

// Supplies used. The Store hands supplies to a department (Store > Supplies >
// Issue); the department holds them and records each use here, with a note.
// Mistakes are undone, never deleted: the line stays, marked undone, with the
// reason. The auditor sees everything, including balances that went negative
// (used more than the Store handed over).
const QUICK = ['Cooking', 'Cleaning rooms', 'Laundry', 'Packing orders', 'Office', 'Guest rooms', 'Bar service']
const KEEPERS = ['storekeeper', 'manager', 'gm', 'admin']

export default function Supplies({ boot }) {
  const { staff, locations, allLocations, supplyItems = [] } = boot
  const toast = useToast()
  const isKeeper = KEEPERS.includes(staff.role)
  const canRecord = staff.role !== 'auditor' && !staff.is_read_only

  const places = useMemo(
    () => ((isKeeper || staff.role === 'auditor') ? allLocations : locations).filter(l => !l.is_store),
    [isKeeper, staff.role, allLocations, locations])

  const [locId, setLocId] = useState(null)         // null = all (viewing only)
  useEffect(() => {
    if (canRecord && !isKeeper) {
      if (!places.some(l => l.id === locId)) {
        const own = places.find(l => l.id === staff.default_location_id)
        setLocId((own || places[0] || {}).id || null)
      }
    } else if (locId && !places.some(l => l.id === locId)) setLocId(null)
  }, [places, locId, canRecord, isKeeper, staff.default_location_id])

  const [stockMap, setStockMap] = useState({})
  const [deptLists, setDeptLists] = useState({})
  const isAdmin = ['gm', 'admin'].includes(staff.role)
  const [feed, setFeed] = useState(null)
  const [days, setDays] = useState(30)
  const [view, setView] = useState(canRecord ? 'record' : 'entries')  // record | entries | balances
  const [q, setQ] = useState('')
  const [lines, setLines] = useState([])
  const [note, setNote] = useState('')
  const [usedBy, setUsedBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [undoing, setUndoing] = useState(null)     // { id, reason }

  const refresh = () => {
    loadStockMap(staff.branch_id).then(setStockMap).catch(console.error)
    loadSuppliesUse(staff.branch_id, days).then(setFeed).catch(() => setFeed([]))
    loadDepartmentSupplies(staff.branch_id).then(setDeptLists).catch(() => {})
  }
  useEffect(refresh, [staff.branch_id, days])
  useEffect(() => { setLines([]); setNote(''); setUsedBy('') }, [locId])

  const recordHere = canRecord && !!locId
  const onHand = (id) => stockMap[`${id}:${locId}`] ?? 0
  const shown = useMemo(() => (feed || []).filter(r => !locId || r.dept_id === locId), [feed, locId])

  const list = useMemo(() => {
    const n = q.trim().toLowerCase()
    const allowed = deptLists[locId]
    return supplyItems.filter(i => (!allowed || allowed.has(i.id)) && (!n || i.name.toLowerCase().includes(n)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [supplyItems, q, deptLists, locId])

  const setQty = (item, qty) => setLines(ls => {
    const v = Math.max(0, Number(qty) || 0)
    if (!v) return ls.filter(l => l.item.id !== item.id)
    return ls.some(l => l.item.id === item.id)
      ? ls.map(l => l.item.id === item.id ? { ...l, qty: v } : l) : [...ls, { item, qty: v }]
  })

  const over = lines.filter(l => l.qty > onHand(l.item.id))

  async function save() {
    if (!lines.length) { toast('Pick what was used', 'error'); return }
    if (note.trim().length < 3) { toast('Say what it was used for', 'error'); return }
    setBusy(true)
    try {
      await recordSuppliesUse(locId, lines, note.trim(), usedBy.trim() || null)
      toast('Recorded', 'success')
      setLines([]); setNote(''); setUsedBy(''); refresh()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function undo() {
    if ((undoing.reason || '').trim().length < 3) { toast('Say why it is being undone', 'error'); return }
    setBusy(true)
    try {
      await voidSuppliesUse(undoing.id, undoing.reason.trim())
      toast('Undone — quantity put back', 'success')
      setUndoing(null); refresh()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  const canUndo = (r) => canRecord && r.kind === 'used' && !r.undone &&
    (isKeeper ? r.business_date >= lagosDaysAgo(30)
              : r.recorded_by === staff.id && r.business_date >= lagosDaysAgo(6))

  const tabs = [...(canRecord ? [['record', 'Record use']] : []), ['entries', 'Entries'], ['balances', 'Balances'],
    ...(isAdmin ? [['lists', 'Lists']] : [])]

  return (
    <div className="px-4 pb-10 w-full max-w-full overflow-x-hidden">
      <div className="flex gap-2 overflow-x-auto py-2 items-center [scrollbar-width:none]">
        {(!canRecord || isKeeper) && <Chip on={!locId} onClick={() => setLocId(null)}>All</Chip>}
        {places.map(l => <Chip key={l.id} on={l.id === locId} onClick={() => setLocId(l.id)}>{l.name}</Chip>)}
      </div>

      <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`h-9 px-1 rounded-lg border text-[13px] leading-none whitespace-nowrap truncate font-bold ${view === k
              ? 'bg-amber/20 text-amber border-amber' : 'border-line text-dim'}`}>{label}</button>
        ))}
      </div>

      {view === 'record' && canRecord && (
        recordHere ? (
          <section>
            <p className="text-dim text-sm mb-2">
              Record what {places.find(l => l.id === locId)?.name} used. A note saying why is required.
              Entered by mistake? Undo it under Entries.
            </p>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search supplies"
              className="w-full h-12 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
            <ul className="mt-2 divide-y divide-line/60">
              {list.map(i => {
                const line = lines.find(l => l.item.id === i.id)
                const have = onHand(i.id)
                return (
                  <li key={i.id} className="py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{i.name}</p>
                      <p className={`text-xs tnum ${have <= 0 ? 'text-clay' : 'text-dim'}`}>{have} held here</p>
                    </div>
                    <button onClick={() => setQty(i, (line?.qty || 0) - 1)} disabled={!line}
                      className="w-10 h-10 rounded-lg border border-line disabled:opacity-30">−</button>
                    <input inputMode="decimal" value={line?.qty ?? ''} placeholder="0"
                      onChange={e => setQty(i, e.target.value)}
                      className="w-14 h-10 text-center rounded-lg bg-surface border border-line tnum" />
                    <button onClick={() => setQty(i, (line?.qty || 0) + 1)}
                      className="w-10 h-10 rounded-lg border border-line">+</button>
                  </li>
                )
              })}
              {!list.length && <li className="py-6 text-center text-dim">No supplies in the catalogue yet.</li>}
            </ul>

            <div className="mt-3">
              {isKeeper && (
                <input value={usedBy} onChange={e => setUsedBy(e.target.value)}
                  placeholder="Who took it? (when you record for someone else)"
                  className="w-full h-12 px-4 mb-2 rounded-xl bg-surface border border-line placeholder:text-dim" />
              )}
              <div className="flex gap-2 overflow-x-auto pb-2">
                {QUICK.map(t => (
                  <button key={t} onClick={() => setNote(n => n ? n : t)}
                    className="shrink-0 h-9 px-3 rounded-full border border-line text-dim text-sm">{t}</button>
                ))}
              </div>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                placeholder="What was it used for? (required)"
                className="w-full px-4 py-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
              {!!over.length && (
                <p className="text-clay text-sm mt-2">
                  More than is held here: {over.map(l => l.item.name).join(', ')}. It will still save, and the
                  auditor will see it. Check the quantity, or ask the Store whether supplies were sent.
                </p>
              )}
              <button onClick={save} disabled={busy || !lines.length}
                className="mt-2 w-full h-12 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
                {busy ? 'Saving…' : `Record use${lines.length ? ` (${lines.length})` : ''}`}
              </button>
            </div>
          </section>
        ) : <p className="py-8 text-center text-dim">Pick a department above to record its use.</p>
      )}

      {view === 'entries' && (
        <section>
          <div className="flex gap-2 mb-3">
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`h-9 px-3 rounded-full border text-sm ${d === days
                  ? 'border-amber text-amber font-bold' : 'border-line text-dim'}`}>{d} days</button>
            ))}
          </div>
          {feed === null && <p className="py-8 text-center text-dim">Loading…</p>}
          <ul className="divide-y divide-line/60">
            {shown.map(r => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`flex-1 min-w-0 font-semibold truncate ${r.undone ? 'line-through text-dim' : ''}`}>
                    {r.kind === 'received' ? '+' : r.kind === 'undo' ? '↩' : '−'}{Number(r.qty)} × {r.stock_items?.name}
                  </span>
                  <span className="tnum text-dim">{r.business_date}</span>
                </div>
                <p className="text-dim">
                  {r.dept_name || '—'} ·{' '}
                  {r.kind === 'received' ? `from Store${r.received_by ? `, collected by ${r.received_by}` : ''}`
                    : r.kind === 'undo' ? 'undone'
                    : `used${r.received_by ? ` (taken by ${r.received_by})` : ''}`}
                  {` · by ${r.staff?.full_name || '?'}`}
                  {r.undone ? ' · UNDONE' : ''}
                </p>
                {r.kind === 'used' && (
                  <p className={!r.note || r.note.trim().length < 5 ? 'text-clay' : 'text-dim'}>“{r.note || 'no note'}”</p>
                )}
                {r.kind === 'undo' && <p className="text-dim">{r.note}</p>}
                {canUndo(r) && (undoing?.id === r.id ? (
                  <div className="mt-2 flex gap-2">
                    <input value={undoing.reason} autoFocus
                      onChange={e => setUndoing({ id: r.id, reason: e.target.value })}
                      placeholder="Why undo? (e.g. wrong quantity)"
                      className="flex-1 h-10 px-3 rounded-lg bg-surface border border-line placeholder:text-dim" />
                    <button onClick={undo} disabled={busy}
                      className="h-10 px-3 rounded-lg bg-clay text-bg font-bold disabled:opacity-40">Undo</button>
                    <button onClick={() => setUndoing(null)} className="h-10 px-2 text-dim">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setUndoing({ id: r.id, reason: '' })}
                    className="mt-1 text-amber text-sm font-semibold">Undo this entry</button>
                ))}
              </li>
            ))}
            {feed && !shown.length && <li className="py-8 text-center text-dim">Nothing in this period.</li>}
          </ul>
        </section>
      )}

      {view === 'balances' && (
        <Balances feed={feed} stockMap={stockMap} locId={locId} places={places} items={supplyItems} days={days}
          setDays={setDays} canReturn={isKeeper} onChanged={refresh}
          store={(allLocations || locations).find(l => l.is_store)} />
      )}

      {view === 'lists' && isAdmin && (
        <Lists places={places} locId={locId} items={supplyItems} deptLists={deptLists} onChanged={refresh} />
      )}
    </div>
  )
}

// Per department and item: handed over by the Store, used (net of undone), and
// what the system says is still held. Negative = used more than was handed over.
function Balances({ feed, stockMap, locId, places, items, days, setDays, canReturn, onChanged, store }) {
  const toast = useToast()
  const [ret, setRet] = useState(null)   // { dept, item, qty, reason }
  const [busy, setBusy] = useState(false)
  async function doReturn() {
    if (!(ret.qty > 0)) { toast('Enter how many', 'error'); return }
    if ((ret.reason || '').trim().length < 3) { toast('Say why it is going back', 'error'); return }
    setBusy(true)
    try {
      await returnSuppliesToStore(ret.dept, ret.item, Number(ret.qty), ret.reason.trim())
      toast('Returned to the Store', 'success'); setRet(null); onChanged()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }
  const depts = locId ? places.filter(p => p.id === locId) : places
  if (feed === null) return <p className="py-8 text-center text-dim">Loading…</p>
  const byKey = {}
  for (const r of feed) {
    const k = `${r.dept_id}:${r.stock_item_id}`
    const e = byKey[k] || (byKey[k] = { got: 0, used: 0 })
    if (r.kind === 'received') e.got += Number(r.qty)
    else if (r.kind === 'used') e.used += Number(r.qty)
    else if (r.kind === 'undo') e.used -= Number(r.qty)
  }
  return (
    <section>
      <div className="flex gap-2 mb-3">
        {[7, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`h-9 px-3 rounded-full border text-sm ${d === days
              ? 'border-amber text-amber font-bold' : 'border-line text-dim'}`}>{d} days</button>
        ))}
      </div>
      {store && !locId && (
        <div className="mb-4 rounded-2xl border border-amber/60 bg-surface px-4 py-3">
          <p className="font-bold">In the Store</p>
          <p className="text-dim text-xs mb-1">What is still in the Store, waiting to be issued.</p>
          {items.map(i => {
            const have = stockMap[`${i.id}:${store.id}`] ?? 0
            const out = Object.entries(byKey).reduce((s2, [k, e]) =>
              k.endsWith(':' + i.id) ? s2 + e.got : s2, 0)
            if (!have && !out) return null
            return (
              <div key={i.id} className="flex items-baseline gap-2 py-1 text-sm">
                <span className="flex-1 min-w-0 truncate">{i.name}</span>
                <span className="text-dim tnum">−{out} issued</span>
                <span className={`tnum w-14 text-right font-semibold ${have < 0 ? 'text-clay' : ''}`}>{have}</span>
              </div>
            )
          })}
        </div>
      )}

      {depts.map(d => {
        const rows = items.map(i => ({ i, e: byKey[`${d.id}:${i.id}`] || { got: 0, used: 0 }, have: stockMap[`${i.id}:${d.id}`] ?? 0 }))
          .filter(r => r.e.got || r.e.used || r.have)
          .sort((a, b) => a.have - b.have)
        return (
          <div key={d.id} className="mb-4 rounded-2xl border border-line bg-surface px-4 py-3">
            <p className="font-bold">{d.name}</p>
            {!rows.length && <p className="text-dim text-sm mt-1">No supplies held or used.</p>}
            {rows.map(({ i, e, have }) => (
              <div key={i.id}>
              <div className="flex items-baseline gap-2 py-1 text-sm">
                <span className="flex-1 min-w-0 truncate">{i.name}</span>
                <span className="text-dim tnum">+{e.got} / −{e.used}</span>
                <span className={`tnum w-14 text-right font-semibold ${have < 0 ? 'text-clay' : ''}`}>{have}</span>
                {canReturn && have > 0 && (
                  <button onClick={() => setRet({ dept: d.id, item: i.id, qty: '', reason: '' })}
                    className="text-amber text-xs font-semibold">Return</button>
                )}
              </div>
              {ret && ret.dept === d.id && ret.item === i.id && (
                <div className="flex flex-wrap gap-2 pb-2">
                  <input inputMode="decimal" value={ret.qty} placeholder="How many"
                    onChange={e => setRet({ ...ret, qty: e.target.value })}
                    className="w-24 h-10 px-3 rounded-lg bg-raise border border-line tnum" />
                  <input value={ret.reason} placeholder="Why? (e.g. issued to wrong department)"
                    onChange={e => setRet({ ...ret, reason: e.target.value })}
                    className="flex-1 min-w-40 h-10 px-3 rounded-lg bg-raise border border-line placeholder:text-dim" />
                  <button onClick={doReturn} disabled={busy}
                    className="h-10 px-3 rounded-lg bg-amber text-bg font-bold disabled:opacity-40">Send back</button>
                  <button onClick={() => setRet(null)} className="h-10 px-2 text-dim">Cancel</button>
                </div>
              )}
              </div>
            ))}
            {rows.length > 0 && (
              <p className="text-dim text-xs mt-1">+received from Store / −used in the period · right-hand number is held now (red = used more than received).</p>
            )}
          </div>
        )
      })}
    </section>
  )
}

// GM / admin: which supplies each department may hold and use.
function Lists({ places, locId, items, deptLists, onChanged }) {
  const toast = useToast()
  const [busyKey, setBusyKey] = useState(null)
  const depts = locId ? places.filter(p => p.id === locId) : places
  async function toggle(d, i, on) {
    setBusyKey(d.id + i.id)
    try { await setDepartmentSupply(d.id, i.id, on); onChanged() }
    catch (e) { toast(e.message, 'error') }
    setBusyKey(null)
  }
  return (
    <section>
      <p className="text-dim text-sm mb-3">
        Tick the supplies each department may hold and use. The Store can only issue these to it, and its staff
        only see these. A department with nothing ticked is unrestricted.
      </p>
      {depts.map(d => {
        const set = deptLists[d.id]
        return (
          <div key={d.id} className="mb-4 rounded-2xl border border-line bg-surface px-4 py-3">
            <p className="font-bold">{d.name} <span className="text-dim text-xs font-normal">
              {set ? `${set.size} allowed` : 'unrestricted'}</span></p>
            <ul className="mt-1">
              {items.map(i => {
                const on = !!set?.has(i.id)
                return (
                  <li key={i.id}>
                    <label className="flex items-center gap-3 py-1.5 text-sm">
                      <input type="checkbox" checked={on} disabled={busyKey === d.id + i.id}
                        onChange={e => toggle(d, i, e.target.checked)} className="w-5 h-5" />
                      <span className={on ? '' : 'text-dim'}>{i.name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 h-9 px-3.5 rounded-full border text-sm whitespace-nowrap ${on
        ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{children}</button>
  )
}
