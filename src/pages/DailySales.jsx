import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, tierLabel, methodLabel, whoRecorded, paymentSummary } from '../lib/format'
import { loadDailyFinancials, loadToday, loadReceptionActivity, loadRestaurantRoomCharges } from '../lib/data'
import { useToast } from '../components/Toast'

// Read-only — browse any past day's sales by department. Built for
// the auditor (who has no live Sales tab at all, by design — never
// records), and shared with storekeeper/manager/gm/admin as a way to
// look at a day other than today without switching into the live
// recording screen.
export default function DailySales({ boot }) {
  const { staff, locations, items } = boot
  const salesPoints = (locations || []).filter(l => l.is_sales_point && !l.is_store)
  const toast = useToast()

  const [date, setDate] = useState(lagosToday())
  const [locId, setLocId] = useState('all')
  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState(null)
  const [receptionActivity, setReceptionActivity] = useState(null)
  const [roomCharges, setRoomCharges] = useState([])

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries(salesPoints.map(l => [l.id, l])), [salesPoints])
  const isReception = /reception/i.test(salesPoints.find(l => l.id === locId)?.name || '')
  const isRestaurant = /restaurant/i.test(salesPoints.find(l => l.id === locId)?.name || '')

  const refresh = useCallback(() => {
    const loc = locId === 'all' ? null : locId
    setSummary(null); setRows(null); setReceptionActivity(null); setRoomCharges([])
    if (isReception) {
      loadReceptionActivity(staff.branch_id, date).then(setReceptionActivity).catch(e => toast(e.message, 'error'))
      return
    }
    loadDailyFinancials(staff.branch_id, date, loc).then(setSummary).catch(e => toast(e.message, 'error'))
    loadToday(staff.branch_id, date, loc).then(setRows).catch(e => toast(e.message, 'error'))
    if (isRestaurant) {
      loadRestaurantRoomCharges(staff.branch_id, date).then(setRoomCharges).catch(e => toast(e.message, 'error'))
    }
  }, [staff.branch_id, date, locId, isReception, isRestaurant])
  useEffect(refresh, [refresh])

  // Restaurant food charged to a room lives in orders/order_items, not
  // sales — merged into the same list sales already populate, sorted
  // together chronologically, same as the Sales screen's own Today
  // list already does. Deliberately doesn't touch summary/grossSales
  // above — those stay sales-only by design, since a room charge
  // settles through the guest's folio, not this department's own
  // till figures.
  const combinedRows = useMemo(() => {
    const sales = (rows || []).map(r => ({ ...r, entryKind: 'sale', sortAt: r.created_at }))
    if (!isRestaurant) return sales
    const charges = roomCharges.map(r => ({
      ...r, entryKind: 'roomCharge', sortAt: r.orders?.created_at,
      roomNumber: r.orders?.stays?.rooms?.room_number, guestName: r.orders?.stays?.guests?.full_name,
    }))
    return [...sales, ...charges].sort((a, b) => (b.sortAt || '').localeCompare(a.sortAt || ''))
  }, [rows, roomCharges, isRestaurant])

  const total = combinedRows.reduce((s, r) => s + Number(r.amount ?? r.qty * r.unit_price), 0)

  return (
    <div className="px-5">
      <input type="date" value={date} max={lagosToday()}
        onChange={e => setDate(e.target.value)}
        className="w-full h-12 px-3 mt-1 mb-2 rounded-xl bg-surface border border-line tnum" />

      {salesPoints.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
          <button onClick={() => setLocId('all')}
            className={`shrink-0 h-11 px-4 rounded-full border ${locId === 'all'
              ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
            All departments
          </button>
          {salesPoints.map(l => (
            <button key={l.id} onClick={() => setLocId(l.id)}
              className={`shrink-0 h-11 px-4 rounded-full border ${locId === l.id
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}

      {isReception ? (
        <>
          <div className="flex items-baseline justify-between mt-4">
            <h2 className="text-dim">
              {receptionActivity?.length || 0} payment{receptionActivity?.length === 1 ? '' : 's'}
            </h2>
            <span className="tnum font-bold">
              {naira((receptionActivity || []).reduce((s, p) => s + Number(p.amount || 0), 0))}
            </span>
          </div>
          <ul className="mt-2 divide-y divide-line/60">
            {(receptionActivity || []).map(p => (
              <li key={p.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">
                    {p.stays?.guests?.full_name || 'Guest'} · Room {p.stays?.rooms?.room_number || '—'}
                  </div>
                  <div className="text-dim text-sm">
                    {methodLabel[p.method] || p.method}{p.is_overstay ? ' · over-stay' : ''}
                    {p.staff?.full_name && ` · collected by ${p.staff.full_name}`}
                    {p.remark ? ` · ${p.remark}` : ''}
                  </div>
                </div>
                <span className="tnum font-semibold">{naira(p.amount)}</span>
              </li>
            ))}
            {receptionActivity && !receptionActivity.length && (
              <li className="py-8 text-center text-dim">No payments that day.</li>
            )}
            {!receptionActivity && <li className="py-8 text-center text-dim">Loading…</li>}
          </ul>
        </>
      ) : (
      <>
      {summary && (
        <div className="mt-2 rounded-2xl border border-amber bg-surface p-4">
          <div className="grid grid-cols-3 gap-3 pb-3 mb-3 border-b border-line">
            {['pos', 'cash', 'credit'].map(m => (
              <div key={m}>
                <div className="text-dim text-sm">{methodLabel[m] || m}</div>
                <div className="tnum font-bold">{naira((summary.byMethod || {})[m] || 0)}</div>
              </div>
            ))}
          </div>
          <div className="text-dim text-sm">Gross sales — value of goods sold</div>
          <div className="tnum text-3xl font-bold text-amber">{naira(summary.grossSales)}</div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-dim">Received (POS + Cash)</span>
              <span className="tnum">{naira(summary.received)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-dim">Credit raised</span>
              <span className={`tnum ${summary.creditRaised > 0 ? 'text-clay' : ''}`}>{naira(summary.creditRaised)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-dim">Debt recovered</span>
              <span className="tnum text-leaf">{naira(summary.debtRecovered)}</span>
            </div>
            {Object.entries(summary.recoveredBy || {}).map(([m, amt]) => (
              <div key={m} className="flex justify-between pl-4">
                <span className="text-dim">· recovered by {methodLabel[m] || m}</span>
                <span className="tnum text-dim">{naira(amt)}</span>
              </div>
            ))}
            <div className="pt-2 mt-2 border-t border-line flex justify-between font-bold">
              <span>Total income for the day</span>
              <span className="tnum">{naira(summary.totalMoneyIn)}</span>
            </div>
          </div>
          {!!(summary.nonRevenue || []).length && (
            <div className="mt-3 pt-3 border-t border-line">
              <div className="text-dim text-sm mb-1">Not income — stock out without payment</div>
              {summary.nonRevenue.map(r => (
                <div key={r.kind} className="flex justify-between text-sm">
                  <span className="text-dim">{r.kind === 'complimentary' ? 'PR / free' : 'Damaged'}</span>
                  <span className="tnum">{r.qty} units{Number(r.value) > 0 && ` · ${naira(r.value)}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-baseline justify-between mt-4">
        <h2 className="text-dim">
          {rows?.length || 0} sale{rows?.length === 1 ? '' : 's'}
        </h2>
        <span className="tnum font-bold">{naira(total)}</span>
      </div>

      <ul className="mt-2 divide-y divide-line/60">
        {combinedRows.map(r => (
          <li key={`${r.entryKind}:${r.id}`} className="py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{itemById[r.stock_item_id]?.name || r.description || '—'}</div>
              {r.entryKind === 'roomCharge' ? (
                <div className="text-dim text-sm">
                  {r.qty} × {naira(r.unit_price)}
                  <br />Charged to Room {r.roomNumber || '—'}{r.guestName ? ` · ${r.guestName}` : ''}
                </div>
              ) : (
                <div className="text-dim text-sm">
                  {tierLabel[r.tier] || r.tier} · {r.qty} × {naira(r.unit_price)}
                  {locId === 'all' && locById[r.location_id] ? ` · ${locById[r.location_id].name}` : ''}
                  <br />{paymentSummary(r)} · {whoRecorded(r)}
                </div>
              )}
            </div>
            <div className="tnum font-semibold">{naira(r.amount ?? r.qty * r.unit_price)}</div>
          </li>
        ))}
        {rows && !combinedRows.length && <li className="py-8 text-center text-dim">No sales that day.</li>}
        {!rows && <li className="py-8 text-center text-dim">Loading…</li>}
      </ul>
      </>
      )}
    </div>
  )
}
