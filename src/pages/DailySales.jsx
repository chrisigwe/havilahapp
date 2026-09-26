import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, tierLabel, methodLabel, whoRecorded, paymentSummary } from '../lib/format'
import { loadDailyFinancials, loadToday, loadReceptionActivity, loadReceptionDashboard,
         loadRoomCharges, loadRoomsSoldInMonth } from '../lib/data'
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
  const [receptionDashboard, setReceptionDashboard] = useState(null)
  const [roomCharges, setRoomCharges] = useState([])
  const [roomsSold, setRoomsSold] = useState(null)

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries(salesPoints.map(l => [l.id, l])), [salesPoints])
  const isReception = /reception/i.test(salesPoints.find(l => l.id === locId)?.name || '')
  const isRestaurant = /restaurant/i.test(salesPoints.find(l => l.id === locId)?.name || '')
  // Room 209 (GM Office) and the monthly rooms-sold count are both
  // GM/admin-only visibility on this dashboard — matches
  // is_supervisor()'s own role set, not the broader oversight group.
  const isGmOrAdmin = ['gm', 'admin'].includes(staff.role)
  const visibleRoomRateProgress = (receptionDashboard?.roomRateProgress || [])
    .filter(r => isGmOrAdmin || r.room_number !== '209')
  const visibleRoomRateRemainingTotal = visibleRoomRateProgress.reduce((s, r) => s + r.remaining, 0)
  const currentDept = salesPoints.find(l => l.id === locId)
  const roomChargeCategory = isReception ? null
    : isRestaurant ? 'food'
    : /minimart/i.test(currentDept?.name || '') ? 'minimart'
    : locId === 'all' ? null // "All" has no single category to filter by
    : 'drink'

  const refresh = useCallback(() => {
    const loc = locId === 'all' ? null : locId
    setSummary(null); setRows(null); setReceptionActivity(null); setRoomCharges([]); setReceptionDashboard(null); setRoomsSold(null)
    if (isReception) {
      loadReceptionActivity(staff.branch_id, date).then(setReceptionActivity).catch(e => toast(e.message, 'error'))
      // Deferred/advance are computed from CURRENT balances (v_stay_
      // folio has no historical snapshot for a past date) — only
      // meaningful, and only shown, when actually looking at today.
      if (date === lagosToday()) {
        loadReceptionDashboard(staff.branch_id, date).then(setReceptionDashboard).catch(e => toast(e.message, 'error'))
      }
      // Rooms sold, unlike the above, is a real historical count —
      // works for any browsed month, not just today.
      if (isGmOrAdmin) {
        loadRoomsSoldInMonth(staff.branch_id, date).then(setRoomsSold).catch(() => {})
      }
      return
    }
    loadDailyFinancials(staff.branch_id, date, loc).then(setSummary).catch(e => toast(e.message, 'error'))
    loadToday(staff.branch_id, date, loc).then(setRows).catch(e => toast(e.message, 'error'))
    if (roomChargeCategory) {
      loadRoomCharges(staff.branch_id, date, roomChargeCategory).then(setRoomCharges).catch(e => toast(e.message, 'error'))
    }
  }, [staff.branch_id, date, locId, isReception, roomChargeCategory])
  useEffect(refresh, [refresh])

  // A room charge from any department lives in orders/order_items,
  // not sales — merged into the same list sales already populate,
  // sorted together chronologically, same as the Sales screen's own
  // Today list already does. Deliberately doesn't touch summary/
  // grossSales above — those stay sales-only by design, since a room
  // charge settles through the guest's folio, not this department's
  // own till figures.
  const combinedRows = useMemo(() => {
    const sales = (rows || []).map(r => ({ ...r, entryKind: 'sale', sortAt: r.created_at }))
    if (!roomChargeCategory) return sales
    const charges = roomCharges.map(r => ({
      ...r, entryKind: 'roomCharge', sortAt: r.orders?.created_at,
      roomNumber: r.orders?.stays?.rooms?.room_number, guestName: r.orders?.stays?.guests?.full_name,
    }))
    return [...sales, ...charges].sort((a, b) => (b.sortAt || '').localeCompare(a.sortAt || ''))
  }, [rows, roomCharges, roomChargeCategory])

  const total = combinedRows.reduce((s, r) => s + Number(r.amount ?? r.qty * r.unit_price), 0)

  return (
    <div className="px-5">
      <input type="date" value={date} max={lagosToday()}
        onChange={e => setDate(e.target.value)}
        className="h-12 px-3 mt-1 mb-2 rounded-xl bg-surface border border-line tnum" />

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
          {isGmOrAdmin && roomsSold != null && (
            <p className="text-dim text-sm mt-3">
              {roomsSold} room{roomsSold === 1 ? '' : 's'} sold {date.slice(0, 7) === lagosToday().slice(0, 7) ? 'this month' : 'in this month'}
            </p>
          )}
          {receptionDashboard && (
            <div className="mt-4 rounded-2xl border border-amber bg-surface p-4">
              <p className="font-semibold">Close of day</p>
              <div className="grid grid-cols-3 gap-3 mt-3 pb-3 border-b border-line">
                <div>
                  <div className="text-dim text-sm">POS</div>
                  <div className="tnum font-bold">{naira(receptionDashboard.pos)}</div>
                </div>
                <div>
                  <div className="text-dim text-sm">Cash</div>
                  <div className="tnum font-bold">{naira(receptionDashboard.cash)}</div>
                </div>
                <div>
                  <div className="text-dim text-sm">Credit</div>
                  <div className="tnum font-bold text-clay">{naira(receptionDashboard.deferredTotal)}</div>
                </div>
              </div>

              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-dim">Deferred — owed across every live stay</span>
                <span className="tnum font-bold text-clay">{naira(receptionDashboard.deferredTotal)}</span>
              </div>
              <div className="mt-1 space-y-1">
                {receptionDashboard.deferred.map(g => (
                  <div key={g.stay_id} className="flex justify-between text-sm">
                    <span className="text-dim truncate">{g.guest_name || 'Guest'} · Room {g.room_number}</span>
                    <span className="tnum">{naira(g.outstanding + g.departmentCredit + g.billedToYou)}</span>
                  </div>
                ))}
                {!receptionDashboard.deferred.length && (
                  <p className="text-dim text-sm">Nothing deferred right now.</p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-line flex items-baseline justify-between">
                <span className="text-dim">Room rate — period progress</span>
                <span className="tnum font-bold text-leaf">{naira(visibleRoomRateRemainingTotal)} left</span>
              </div>
              <div className="mt-1 space-y-2">
                {visibleRoomRateProgress.map(r => (
                  <div key={r.stay_id} className="text-sm">
                    <div className="flex justify-between">
                      <span className="text-dim truncate">{r.guest_name || 'Guest'} · Room {r.room_number}</span>
                      <span className="text-dim">{r.nightsElapsed}/{r.totalNights}n · {r.nightsLeft} left</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-line overflow-hidden mt-1">
                      <div className="h-full bg-clay" style={{ width: `${r.pctElapsed}%` }} />
                    </div>
                    <div className="text-dim text-xs mt-0.5">
                      {naira(r.consumed)} taken out · {naira(r.remaining)} left to {r.scheduled_out}
                    </div>
                  </div>
                ))}
                {!visibleRoomRateProgress.length && (
                  <p className="text-dim text-sm">No multi-night stays right now.</p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-line flex items-baseline justify-between">
                <span className="text-dim">In-house today — every occupied room</span>
                <span className="tnum font-bold">{receptionDashboard.inHouse.length}</span>
              </div>
              <p className="text-dim text-xs mt-0.5">
                Everyone stays listed here whether they paid, are on credit, or had no
                activity today — nobody drops off this list just for not transacting.
              </p>
              <div className="mt-2 space-y-1.5">
                {receptionDashboard.inHouse.map(g => (
                  <div key={g.stay_id} className="flex justify-between text-sm">
                    <span className="text-dim truncate">{g.guest_name || 'Guest'} · Room {g.room_number}</span>
                    {g.status === 'paid' && (
                      <span className="tnum text-leaf">Paid {naira(g.paidToday)} today</span>
                    )}
                    {g.status === 'credit' && (
                      <span className="tnum text-clay">On credit · {naira(g.outstanding)} owing</span>
                    )}
                    {g.status === 'settled' && (
                      <span className="text-dim">Settled · no activity today</span>
                    )}
                  </div>
                ))}
                {!receptionDashboard.inHouse.length && (
                  <p className="text-dim text-sm">No occupied rooms right now.</p>
                )}
              </div>
            </div>
          )}
          {date !== lagosToday() && (
            <p className="text-dim text-sm mt-4">
              Deferred and advance figures only show for today — they reflect current
              balances, not a snapshot of {date}.
            </p>
          )}

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
            {summary.unqualifiedCredit > 0 && (
              <div className="flex justify-between text-clay">
                <span>Not repaid by noon next day — excluded from sales above</span>
                <span className="tnum">{naira(summary.unqualifiedCredit)}</span>
              </div>
            )}
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
