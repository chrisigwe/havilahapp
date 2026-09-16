import { useEffect, useMemo, useState } from 'react'
import { loadStockMap } from '../lib/data'
import { useToast } from '../components/Toast'
import WriteoffSheet from '../components/WriteoffSheet'

export default function Stock({ boot }) {
  const { staff, locations, items, seesAll } = boot
  const [stockMap, setStockMap] = useState({})
  const [locId, setLocId] = useState('all')
  const [q, setQ] = useState('')
  const [writeoff, setWriteoff] = useState(null)
  const toast = useToast()

  // Only the auditor gets write-off-from-Stock (their RLS allows PR/
  // damage but nothing else, and they have no Sales screen to do it
  // from). Everyone else records write-offs on the Sales screen as
  // before; for them Stock stays read-only.
  const auditorWriteoff = staff.role === 'auditor'

  const refresh = () => loadStockMap(staff.branch_id).then(setStockMap).catch(console.error)
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

  const canTapRow = auditorWriteoff && locId !== 'all'

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
      {auditorWriteoff && (
        <p className="text-dim text-sm mb-2">
          {locId === 'all'
            ? 'Pick a department above, then tap an item to record PR or damage.'
            : 'Tap an item to record PR or damage against this department.'}
        </p>
      )}
      <ul className="divide-y divide-line/60">
        {rows.map(({ item, shown }) => (
          <li key={item.id} className="py-3 flex items-center"
            onClick={canTapRow ? () => setWriteoff({ item, locId }) : undefined}
            style={canTapRow ? { cursor: 'pointer' } : undefined}>
            <span className="flex-1 min-w-0 truncate font-semibold">{item.name}</span>
            <span className={`tnum font-bold ${shown < 0 ? 'text-clay' : shown === 0 ? 'text-dim' : 'text-leaf'}`}>
              {shown}
            </span>
          </li>
        ))}
        {!rows.length && <li className="py-8 text-center text-dim">Nothing here yet.</li>}
      </ul>

      {writeoff && (
        <WriteoffSheet staff={staff} item={writeoff.item} locationId={writeoff.locId}
          toast={toast} onClose={() => setWriteoff(null)} onSaved={refresh} />
      )}
    </div>
  )
}

function LocChip({ active, onClick, children }) {
  return <button onClick={onClick}
    className={`shrink-0 h-11 px-4 rounded-full border ${active
      ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{children}</button>
}
