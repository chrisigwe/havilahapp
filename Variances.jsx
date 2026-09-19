import { useCallback, useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { loadVariances } from '../lib/data'
import { useToast } from '../components/Toast'

export default function Variances({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [rows, setRows] = useState(null)

  const refresh = useCallback(() => {
    loadVariances(staff.branch_id).then(setRows).catch(e => toast(e.message, 'error'))
  }, [staff.branch_id])
  useEffect(refresh, [refresh])

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  const total = rows.reduce((s, r) => s + Number(r.difference), 0)

  return (
    <div className="px-5">
      <p className="text-dim text-sm py-2">
        Sales where what was collected does not match the value of goods sold.
        Last 30 days.
      </p>

      {!!rows.length && (
        <div className="rounded-2xl border border-clay bg-surface p-4 mb-3">
          <div className="text-dim text-sm">Unaccounted across {rows.length} sale{rows.length > 1 ? 's' : ''}</div>
          <div className="tnum text-2xl font-bold text-clay">{naira(total)}</div>
        </div>
      )}

      <ul className="divide-y divide-line/60">
        {rows.map(r => (
          <li key={r.sale_id} className="py-3">
            <div className="flex items-baseline gap-3">
              <span className="flex-1 min-w-0 truncate font-semibold">{r.item_name}</span>
              <span className="tnum text-dim text-sm">{r.business_date?.slice(5)}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm">
              <span className="text-dim flex-1">
                {r.qty} × {naira(r.unit_price)} · {r.recorded_by_name || 'unknown'}
              </span>
            </div>
            <div className="flex gap-4 mt-1 text-sm tnum">
              <span className="text-dim">expected {naira(r.expected)}</span>
              <span className="text-dim">allocated {naira(r.allocated)}</span>
              <span className={Number(r.difference) > 0 ? 'text-clay font-bold' : 'text-amber font-bold'}>
                {naira(r.difference)}
              </span>
            </div>
          </li>
        ))}
        {!rows.length && (
          <li className="py-8 text-center text-leaf">
            Every sale is fully accounted for.
          </li>
        )}
      </ul>
    </div>
  )
}
