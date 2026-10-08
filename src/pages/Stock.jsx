import { useEffect, useMemo, useState } from 'react'
import { loadStockMap } from '../lib/data'
import { OPENS_ON_ALL, is } from '../lib/roles'

export default function Stock({ boot }) {
  const { staff, locations, items, seesAll } = boot
  const [stockMap, setStockMap] = useState({})
  // Opens on the person's own department (their default), so a bartender
  // lands on their bar, not the whole branch. Auditor, GM and admin watch
  // everything, so they open on all, same rule as Recovery.
  const [locId, setLocId] = useState(() =>
    !is(staff.role, OPENS_ON_ALL) && staff.default_location_id
      && locations.some(l => l.id === staff.default_location_id)
      ? staff.default_location_id : 'all')
  // A branch switch can leave the chosen department behind: fall back to all.
  useEffect(() => {
    if (locId !== 'all' && !locations.some(l => l.id === locId)) setLocId('all')
  }, [locations, locId])
  const [q, setQ] = useState('')

  // Read-only for everyone. Auditors used to record PR/damage write-offs
  // here; removed in 255 — an auditor reviews write-offs and shouldn't
  // also be able to create them.

  const refresh = () => { loadStockMap(staff.branch_id).then(setStockMap).catch(console.error) }
  useEffect(refresh, [staff.branch_id])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items
      .map(i => {
        const per = locations.map(l => ({ loc: l, qty: stockMap[`${i.id}:${l.id}`] ?? 0 }))
        const total = per.reduce((s, p) => s + p.qty, 0)
        const shown = locId === 'all' ? total : (per.find(p => p.loc.id === locId)?.qty ?? 0)
        return { item: i, shown, total }
      })
      .filter(r => (locId === 'all' ? r.total !== 0 : r.shown !== 0) || needle)
      .filter(r => !needle || r.item.name.toLowerCase().includes(needle))
      .sort((a, b) => a.item.name.localeCompare(b.item.name))
  }, [items, locations, stockMap, locId, q])

  return (
    <div className="px-5">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stock"
        className="w-full h-13 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
      <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1">
        <LocChip active={locId === 'all'} onClick={() => setLocId('all')}>
          {seesAll ? 'Everywhere' : 'My areas'}
        </LocChip>
        {locations.map(l => (
          <LocChip key={l.id} active={locId === l.id} onClick={() => setLocId(l.id)}>{l.name}</LocChip>
        ))}
      </div>
      <ul className="divide-y divide-line/60">
        {rows.map(({ item, shown }) => (
          <li key={item.id} className="py-3 flex items-center">
            <span className="flex-1 min-w-0 truncate font-semibold">{item.name}</span>
            <span className={`tnum font-bold ${shown < 0 ? 'text-clay' : shown === 0 ? 'text-dim' : 'text-leaf'}`}>
              {shown}
            </span>
          </li>
        ))}
        {!rows.length && <li className="py-8 text-center text-dim">Nothing here yet.</li>}
      </ul>

    </div>
  )
}

function LocChip({ active, onClick, children }) {
  return <button onClick={onClick}
    className={`shrink-0 h-11 px-4 rounded-full border ${active
      ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{children}</button>
}
