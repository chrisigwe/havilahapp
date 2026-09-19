import { useEffect, useMemo, useRef, useState } from 'react'
import { naira } from '../lib/format'

export default function ItemPicker({ items, stockMap, locationId, popular, onPick, onClose }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let l = items
    if (needle) l = l.filter(i => i.name.toLowerCase().includes(needle))
    return [...l].sort((a, b) => {
      if (!needle) {
        const pa = popular[a.id] || 0, pb = popular[b.id] || 0
        if (pa !== pb) return pb - pa
      }
      return a.name.localeCompare(b.name)
    }).slice(0, 60)
  }, [items, q, popular])

  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col">
      <div className="p-4 flex gap-3 items-center border-b border-line">
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search drinks and items"
          className="flex-1 h-13 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        <button onClick={onClose} className="text-dim px-2 py-3">Cancel</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.map(item => {
          const onHand = stockMap[`${item.id}:${locationId}`] ?? 0
          return (
            <button key={item.id} onClick={() => onPick(item)}
              className="w-full text-left px-5 py-4 border-b border-line/60 flex items-center gap-3 active:bg-surface">
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{item.name}</div>
                <div className="text-dim text-sm tnum">{naira(item.selling_price)}</div>
              </div>
              <div className={`tnum text-right text-sm ${onHand <= 0 ? 'text-clay' : 'text-leaf'}`}>
                {onHand} left
              </div>
            </button>
          )
        })}
        {!list.length && <p className="p-8 text-center text-dim">Nothing matches "{q}".</p>}
      </div>
    </div>
  )
}
