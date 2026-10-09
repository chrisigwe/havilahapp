import { useEffect, useState } from 'react'
import { loadStockUsedOnDay } from '../lib/data'

const TYPE = { standard: 'Standard', pr_damage: 'PR / Damage', staff: 'Staff' }

// What the kitchen took from Restaurant stock with orders on one day: totals
// per item, and underneath, each use with the order it belongs to — so what
// left the shelf can be matched to what was served.
export default function StockUsedReport({ branchId, date, locationId = null }) {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!branchId || !date) return
    setRows(null)
    loadStockUsedOnDay(branchId, date, locationId).then(setRows).catch(() => setRows([]))
  }, [branchId, date, locationId])

  if (!rows || !rows.length) return null

  const totals = {}
  for (const r of rows) {
    const n = r.stock_items?.name || 'Item'
    totals[n] = (totals[n] || 0) + Number(r.qty)
  }
  const order = r => r.sales
    ? { what: r.sales.description || 'Order', type: r.sales.order_type, by: r.sales.recorder?.full_name, room: null }
    : { what: r.order_items?.description || 'Order', type: r.order_items?.order_type,
        by: r.order_items?.orders?.served?.full_name, room: r.order_items?.orders?.stays?.rooms?.room_number }

  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">Stock used with orders</p>
          <p className="text-dim text-sm">
            {Object.entries(totals).map(([n, q]) => `${q} × ${n}`).join(' · ')}
          </p>
        </div>
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ul className="px-4 pb-3 divide-y divide-line/60">
          {rows.map(r => {
            const o = order(r)
            return (
              <li key={r.id} className="py-2 text-sm">
                <span className="font-semibold">{Number(r.qty)} × {r.stock_items?.name || 'Item'}</span>
                <span className="text-dim">
                  {' '}— with {o.what}{o.room ? ` (Room ${o.room})` : ''}
                  {TYPE[o.type] && o.type !== 'standard' ? ` · ${TYPE[o.type]}` : ''}
                  {o.by ? ` · ${o.by}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
