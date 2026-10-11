import { useEffect, useMemo, useState } from 'react'
import { loadSuppliesUse } from '../lib/data'

// Supplies used: what the Store handed to each department (salt, detergent,
// Knorr, oil, nylon, lighters ...), who collected it and why. Supplies are
// received into the Store and issued from there (Store > Supplies); this page
// is the record the auditor questions. Nothing is typed here.
const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']]

export default function Supplies({ boot }) {
  const { staff, locations, allLocations } = boot
  const depts = (allLocations || locations).filter(l => !l.is_store)
  const [days, setDays] = useState(30)
  const [locId, setLocId] = useState(null)       // null = all departments
  const [rows, setRows] = useState(null)

  useEffect(() => {
    setRows(null)
    loadSuppliesUse(staff.branch_id, days).then(setRows).catch(() => setRows([]))
  }, [staff.branch_id, days])

  const shown = useMemo(
    () => (rows || []).filter(r => !locId || r.dept_id === locId), [rows, locId])

  const byItem = useMemo(() => {
    const m = {}
    for (const r of shown) {
      const n = r.stock_items?.name || 'Item'
      m[n] = (m[n] || 0) + Number(r.qty)
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [shown])

  const byWho = useMemo(() => {
    const m = {}
    for (const r of shown) {
      const w = r.received_by || 'not named'
      m[w] = (m[w] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [shown])

  return (
    <div className="px-5 pb-10">
      <p className="text-dim text-sm pt-3">
        Supplies handed out by the Store, by department. Store keeper records them under
        Store → Supplies → Issue.
      </p>

      <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1">
        <Chip on={!locId} onClick={() => setLocId(null)}>All</Chip>
        {depts.map(l => (
          <Chip key={l.id} on={l.id === locId} onClick={() => setLocId(l.id)}>{l.name}</Chip>
        ))}
      </div>
      <div className="flex gap-2">
        {RANGES.map(([d, label]) => (
          <button key={d} onClick={() => setDays(d)}
            className={`h-9 px-3 rounded-full border text-sm ${d === days
              ? 'border-amber text-amber font-bold' : 'border-line text-dim'}`}>{label}</button>
        ))}
      </div>

      {rows === null && <p className="py-8 text-center text-dim">Loading…</p>}

      {rows && (
        <>
          <section className="mt-4 rounded-2xl border border-line bg-surface px-4 py-3">
            <p className="font-bold">Totals</p>
            <p className="text-dim text-sm mt-1">
              {byItem.length ? byItem.map(([n, q]) => `${q} × ${n}`).join(' · ') : 'Nothing issued in this period'}
            </p>
            {!!byWho.length && (
              <p className="text-dim text-xs mt-2">
                Collected by: {byWho.map(([w, c]) => `${w} (${c})`).join(' · ')}
              </p>
            )}
          </section>

          <ul className="mt-4 divide-y divide-line/60">
            {shown.map(r => {
              const weak = !r.note || r.note.replace(/^Supplies used:\s*/i, '').trim().length < 4
              return (
                <li key={r.id} className="py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 min-w-0 font-semibold truncate">
                      {Number(r.qty)} × {r.stock_items?.name}
                    </span>
                    <span className="tnum text-dim">{r.business_date}</span>
                  </div>
                  <p className="text-dim">
                    {r.dept_name || '—'}
                    {r.received_by ? ` · collected by ${r.received_by}` : ''}
                    {` · recorded by ${r.staff?.full_name || '?'}`}
                  </p>
                  <p className={weak ? 'text-clay' : 'text-dim'}>
                    “{(r.note || 'no reason given').replace(/^Supplies used:\s*/i, '')}”
                  </p>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 h-11 px-4 rounded-full border ${on
        ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{children}</button>
  )
}
