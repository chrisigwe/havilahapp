import { useEffect, useMemo, useRef, useState } from 'react'
import { naira } from '../lib/format'

// Cross-department item picker for room charges — a guest ordering
// food from OpenBar needs a Restaurant item, so unlike the normal
// ItemPicker (one department at a time), this shows every location
// that actually holds stock of each item, and the person picks the
// (item, location) pair directly.
export default function RoomItemPicker({ items, locations, stockMap, onPick, onClose }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = []
    for (const item of items) {
      if (needle && !item.name.toLowerCase().includes(needle)) continue
      const here = locations
        .map(l => ({ loc: l, qty: stockMap[`${item.id}:${l.id}`] ?? 0 }))
        .filter(p => p.qty > 0)
      if (here.length) out.push({ item, here })
    }
    return out.sort((a, b) => a.item.name.localeCompare(b.item.name)).slice(0, 60)
  }, [items, locations, stockMap, q])

  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col">
      <div className="p-4 flex gap-3 items-center border-b border-line">
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search drinks, food, minimart"
          className="flex-1 h-13 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        <button onClick={onClose} className="text-dim px-2 py-3">Cancel</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.map(({ item, here }) => (
          <div key={item.id} className="px-5 py-4 border-b border-line/60">
            <div className="font-semibold">{item.name}</div>
            <div className="text-dim text-sm tnum mb-2">{naira(item.selling_price)}</div>
            <div className="flex flex-wrap gap-2">
              {here.map(({ loc, qty }) => (
                <button key={loc.id} onClick={() => onPick(item, loc)}
                  className="h-10 px-3 rounded-full border border-line text-sm">
                  {loc.name} <span className="tnum text-dim">· {qty} left</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!rows.length && (
          <p className="p-8 text-center text-dim">
            {q ? `Nothing matches "${q}" with stock anywhere.` : 'Nothing in stock yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
