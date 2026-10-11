import { useEffect, useMemo, useState } from 'react'
import { loadStockMap, loadSuppliesUse, recordSuppliesUse } from '../lib/data'
import { useToast } from '../components/Toast'

// Supplies that are used up rather than sold (salt, detergent, Knorr, oil,
// nylon, lighters ...). Whoever takes them records the quantity and why; the
// auditor can see every entry, by person, with the reason.
const QUICK = ['Cooking', 'Cleaning', 'Laundry', 'Packing orders', 'Office', 'Room supplies']
const KEEPERS = ['storekeeper', 'manager', 'gm', 'admin']
// Recorded by the store on behalf of the people who use them (no logins for them).
const BACK_OFFICE = ['housekeeping', 'laundry', 'others']

export default function Supplies({ boot }) {
  const { staff, locations, items } = boot
  const toast = useToast()
  const canRecord = staff.role !== 'auditor' && !staff.is_read_only

  // Where this person may record. Mirrors record_supplies_use() — the
  // database refuses anything else — so nobody is offered a place it would refuse.
  const places = useMemo(() => locations.filter(l => {
    if (BACK_OFFICE.includes(l.slug) || l.is_store) return KEEPERS.includes(staff.role) || staff.role === 'auditor'
    return true
  }), [locations, staff.role])

  const [locId, setLocId] = useState(() => {
    const own = places.find(l => l.id === staff.default_location_id)
    return (own || places[0] || {}).id || null
  })
  useEffect(() => {
    if (locId && !places.some(l => l.id === locId)) setLocId(places[0]?.id || null)
  }, [places, locId])

  const [stockMap, setStockMap] = useState({})
  const [log, setLog] = useState(null)
  const [q, setQ] = useState('')
  const [lines, setLines] = useState([])     // { item, qty }
  const [note, setNote] = useState('')
  const [usedBy, setUsedBy] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => {
    loadStockMap(staff.branch_id).then(setStockMap).catch(console.error)
    loadSuppliesUse(staff.branch_id, 30).then(setLog).catch(() => setLog([]))
  }
  useEffect(refresh, [staff.branch_id])
  useEffect(() => { setLines([]); setNote(''); setUsedBy('') }, [locId])
  const loc = places.find(l => l.id === locId)
  const backOffice = !!loc && (BACK_OFFICE.includes(loc.slug) || loc.is_store)

  const supplies = useMemo(() => {
    const n = q.trim().toLowerCase()
    return items.filter(i => i.is_consumable && (!n || i.name.toLowerCase().includes(n)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [items, q])

  const onHand = (itemId) => stockMap[`${itemId}:${locId}`] ?? 0
  const inLines = (id) => lines.find(l => l.item.id === id)
  const setQty = (item, qty) => setLines(ls => {
    const v = Math.max(0, Number(qty) || 0)
    if (!v) return ls.filter(l => l.item.id !== item.id)
    return ls.some(l => l.item.id === item.id)
      ? ls.map(l => l.item.id === item.id ? { ...l, qty: v } : l) : [...ls, { item, qty: v }]
  })

  async function save() {
    if (!lines.length) { toast('Pick what was used', 'error'); return }
    if (note.trim().length < 3) { toast('Say what it was used for', 'error'); return }
    if (backOffice && usedBy.trim().length < 2) { toast('Say who took it', 'error'); return }
    setBusy(true)
    try {
      await recordSuppliesUse(locId, lines, note.trim(), backOffice ? usedBy.trim() : null)
      toast('Recorded', 'success')
      setLines([]); setNote(''); setUsedBy(''); refresh()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  const shownLog = useMemo(() => (log || []).filter(r => !locId || r.from_location === locId), [log, locId])
  
  return (
    <div className="px-5 pb-10">
      <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1">
        {places.map(l => (
          <button key={l.id} onClick={() => setLocId(l.id)}
            className={`shrink-0 h-11 px-4 rounded-full border ${l.id === locId
              ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{l.name}</button>
        ))}
      </div>

      {canRecord && locId && (
        <section>
          <h2 className="font-bold text-lg">Supplies used</h2>
          <p className="text-dim text-sm mb-2">
            Take what was used off this department's stock. A note saying why is required.
          </p>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search supplies"
            className="w-full h-12 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
          <ul className="mt-2 divide-y divide-line/60">
            {supplies.map(i => {
              const line = inLines(i.id)
              return (
                <li key={i.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{i.name}</p>
                    <p className={`text-xs tnum ${onHand(i.id) <= 0 ? 'text-clay' : 'text-dim'}`}>
                      {onHand(i.id)} on hand
                    </p>
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
            {!supplies.length && (
              <li className="py-6 text-center text-dim">
                No supplies marked yet. The GM marks them in the Catalog.
              </li>
            )}
          </ul>

          <div className="mt-3">
            {backOffice && (
              <input value={usedBy} onChange={e => setUsedBy(e.target.value)}
                placeholder="Who took it? (required — e.g. the housekeeper's name)"
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
            <button onClick={save} disabled={busy || !lines.length}
              className="mt-2 w-full h-12 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
              {busy ? 'Saving…' : `Record use${lines.length ? ` (${lines.length})` : ''}`}
            </button>
          </div>
        </section>
      )}

      <Report rows={shownLog} canRecord={canRecord} />
    </div>
  )
}

// Last 30 days at this department: totals per item and per person, then every
// entry with its note. This is what the auditor questions.
function Report({ rows, canRecord }) {
  const [open, setOpen] = useState(!canRecord)
  if (!rows) return null
  const byItem = {}, byWho = {}
  for (const r of rows) {
    const n = r.stock_items?.name || 'Item'
    byItem[n] = (byItem[n] || 0) + Number(r.qty)
    const w = r.staff?.full_name || '?'
    byWho[w] = (byWho[w] || 0) + 1
  }
  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">Used in the last 30 days</p>
          <p className="text-dim text-sm truncate">
            {rows.length ? Object.entries(byItem).map(([n, q]) => `${q} × ${n}`).join(' · ') : 'Nothing recorded'}
          </p>
        </div>
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>
      {open && !!rows.length && (
        <div className="px-4 pb-3">
          <p className="text-dim text-xs mb-2">
            By person: {Object.entries(byWho).map(([w, c]) => `${w} (${c})`).join(' · ')}
          </p>
          <ul className="divide-y divide-line/60">
            {rows.map(r => (
              <li key={r.id} className="py-2 text-sm">
                <span className="font-semibold">{Number(r.qty)} × {r.stock_items?.name}</span>
                <span className="text-dim"> · {r.loc?.name} · {r.business_date} · {r.received_by ? `taken by ${r.received_by} · ` : ''}recorded by {r.staff?.full_name || '?'}</span>
                <p className={r.note && r.note.trim().length >= 6 ? 'text-dim' : 'text-clay'}>
                  “{r.note || 'no note'}”
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
