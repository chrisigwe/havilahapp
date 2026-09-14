import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, methodLabel } from '../lib/format'
import { loadRecovery } from '../lib/data'
import { useToast } from '../components/Toast'

export default function Recovery({ boot }) {
  const { staff, locations } = boot
  const toast = useToast()
  const salesPoints = (locations || []).filter(l => l.is_sales_point && !l.is_store)
  const [locId, setLocId] = useState(staff.default_location_id || salesPoints[0]?.id || null)
  const [rows, setRows] = useState(null)

  const refresh = useCallback(() => {
    loadRecovery(staff.branch_id, locId).then(setRows).catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId])
  useEffect(refresh, [refresh])

  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of (rows || [])) {
      if (!m.has(r.paid_on)) m.set(r.paid_on, [])
      m.get(r.paid_on).push(r)
    }
    return [...m.entries()]
  }, [rows])

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  const total = rows.reduce((s, r) => s + Number(r.amount), 0)
  const byMethod = {}
  for (const r of rows) byMethod[r.method] = (byMethod[r.method] || 0) + Number(r.amount)

  return (
    <div className="px-5">
      {salesPoints.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
          {salesPoints.map(l => (
            <button key={l.id} onClick={() => setLocId(l.id)}
              className={`shrink-0 h-11 px-4 rounded-full border ${l.id === locId
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-leaf bg-surface p-4 my-2">
        <div className="text-dim text-sm">Recovered in the last 60 days</div>
        <div className="tnum text-2xl font-bold text-leaf">{naira(total)}</div>
        <div className="flex gap-4 mt-2 text-sm">
          {Object.entries(byMethod).map(([m, amt]) => (
            <span key={m} className="text-dim">
              {methodLabel[m] || m} <span className="tnum text-ink">{naira(amt)}</span>
            </span>
          ))}
        </div>
      </div>

      {byDay.map(([day, items]) => (
        <section key={day} className="mt-4">
          <h3 className="text-dim text-sm">
            {new Date(day + 'T12:00:00').toLocaleDateString('en-NG',
              { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          </h3>
          <ul className="divide-y divide-line/60">
            {items.map(r => (
              <li key={r.id} className="py-3">
                <div className="flex items-baseline gap-3">
                  <span className="flex-1 min-w-0 truncate font-semibold">{r.customer_name}</span>
                  <span className="tnum font-bold text-leaf">{naira(r.amount)}</span>
                </div>
                <div className="text-dim text-sm mt-0.5">
                  {methodLabel[r.method] || r.method}
                  {r.location_name && ` · ${r.location_name}`}
                  {r.recovered_by_name && ` · collected by ${r.recovered_by_name}`}
                  {r.credit_staff_name && r.credit_staff_name !== r.recovered_by_name
                    && ` · credit given by ${r.credit_staff_name}`}
                </div>
                {r.first_credit_date && (
                  <div className="text-dim text-sm">
                    Credit taken {new Date(r.first_credit_date + 'T12:00:00').toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'short' })}
                    {r.last_credit_date && r.last_credit_date !== r.first_credit_date
                      && ` (most recently ${new Date(r.last_credit_date + 'T12:00:00')
                          .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })})`}
                    {' '}· recovered {new Date(r.paid_on + 'T12:00:00').toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'short' })}
                  </div>
                )}
                {r.note && <div className="text-dim text-sm">{r.note}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {!rows.length && <p className="py-8 text-center text-dim">No payments recorded yet.</p>}
    </div>
  )
}
