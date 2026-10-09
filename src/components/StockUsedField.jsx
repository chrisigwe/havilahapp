import { useState } from 'react'
import ItemPicker from './ItemPicker'

// "+ Stock Used": items taken from Restaurant stock with an order (complimentary
// water, 2 extra eggs, extra chicken). Quantities only — never changes the price.
// `used` is [{ item, qty }]; the parent owns it.
export default function StockUsedField({ used, setUsed, items, stockMap, restaurantId }) {
  const [picking, setPicking] = useState(false)
  const bump = (id, d) => setUsed(l => l.map(x => x.item.id === id ? { ...x, qty: Math.max(1, x.qty + d) } : x))
  return (
    <div className="mt-4">
      <button type="button" onClick={() => setPicking(true)}
        className="w-full h-12 rounded-xl border-2 border-amber text-amber font-bold">
        + Stock Used
      </button>
      {!!used.length && (
        <ul className="mt-2 divide-y divide-line/60 rounded-xl border border-line bg-surface px-3">
          {used.map(u => {
            const left = stockMap[`${u.item.id}:${restaurantId}`] ?? 0
            return (
              <li key={u.item.id} className="py-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate font-semibold">{u.item.name}</span>
                  <button onClick={() => bump(u.item.id, -1)}
                    className="h-9 w-9 rounded-lg bg-raise border border-line text-xl">−</button>
                  <span className="tnum w-7 text-center font-bold">{u.qty}</span>
                  <button onClick={() => bump(u.item.id, 1)}
                    className="h-9 w-9 rounded-lg bg-raise border border-line text-xl">+</button>
                  <button onClick={() => setUsed(l => l.filter(x => x.item.id !== u.item.id))}
                    className="h-9 px-2 text-clay text-sm font-semibold">Remove</button>
                </div>
                {u.qty > left && <p className="text-clay text-xs mt-1">Only {left} in Restaurant stock</p>}
              </li>
            )
          })}
        </ul>
      )}
      {picking && (
        <ItemPicker
          items={(items || []).filter(i => restaurantId && stockMap[`${i.id}:${restaurantId}`] !== undefined)}
          stockMap={stockMap} locationId={restaurantId} hidePrice zClass="z-[60]"
          placeholder="Search Restaurant stock"
          onPick={item => {
            setPicking(false)
            setUsed(l => l.some(x => x.item.id === item.id)
              ? l.map(x => x.item.id === item.id ? { ...x, qty: x.qty + 1 } : x)
              : [...l, { item, qty: 1 }])
          }}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}
