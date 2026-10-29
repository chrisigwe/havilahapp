import RoomChargeTracker from '../components/RoomChargeTracker'
import StockUsedReport from '../components/StockUsedReport'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, lagosDaysAgo, tierLabel, methodLabel, roomChargeDept, whoRecorded, paymentSummary } from '../lib/format'
import { findDuplicateCustomers, findDuplicateGuests, loadDailyFinancials, loadReceptionActivity, loadReceptionDashboard, loadRoomBillHandover, loadRoomCharges, loadRoomsSoldInMonth, loadStayDebtRecovered, loadReceptionRoomSales, loadRoomDebtRecovered, withRoomNights, NIGHTS_AS_SALES_FROM, loadToday, loadWriteoffsOnDate } from '../lib/data'
import { useToast } from '../components/Toast'
import ReceptionDashboard from '../components/ReceptionDashboard'
import WriteoffBreakdown from '../components/WriteoffBreakdown'
import TillTile, { SubLine, ByMethod } from '../components/TillTile'
import CorrectionsOnDay from '../components/CorrectionsOnDay'
import { is, SUPERVISOR } from '../lib/roles'
import Notice from '../components/Notice'

// Read-only — browse any past day's sales by department. Built for
// the auditor (who has no live Sales tab at all, by design — never
// records), and shared with storekeeper/manager/gm/admin as a way to
// look at a day other than today without switching into the live
// recording screen.
// Money guests paid against charges their departments made to a room.
//
// This used to read payments.location_id — the old till tag — and fold
// the result into "Debt recovered". Two things were wrong with that.
// The tag says whose DRAWER the money is in, not whose charge it
// settled, and once migration 512 cleared the tags that were untrue the
// figure went to zero: on 15 October this page showed none of the
// ₦110,500 of room-bill money Awka's departments had earned. And it is
// not debt recovery — nobody was on credit — so it never belonged in
// that line.
//
// It now reads the charge ticks, which record exactly which charges a
// payment settled, and it gets a line of its own.
function withRoomBillMoney(f, rows) {
  // The day's own figures carry this money as debt recovered since 531,
  // split by source and by method. All that is wanted from the rows now
  // is WHO paid — the totals used to be recomputed here as well, which
  // is how this page and the Sales page came to disagree.
  return { ...f, roomBill: rows || [] }
}

// Room-rate debt recovered, added here rather than inside
// get_daily_financials (565). A guest who left owing for the room and
// paid later is recovering a debt; until today that money appeared
// only in Reception's takings and in no figure that said what it was.
//
// Added for the whole branch only. It is Reception's money, and adding
// it to a department's day would put it on a till that never held it.
// stays null-safe so the page still renders if the function has not
// been created yet.
function withStayDebt(f, stayDebt) {
  if (!stayDebt || !(stayDebt.total > 0.009)) return { ...f, stayDebt: null }
  return {
    ...f,
    stayDebt,
    debtRecovered: Number(f.debtRecovered || 0) + stayDebt.total,
    totalMoneyIn: Number(f.totalMoneyIn || 0) + stayDebt.total,
  }
}

export default function DailySales({ boot }) {
  const { staff, allLocations, items } = boot
  // Every role that can reach this page (auditor, storekeeper,
  // manager, gm, admin — see More.jsx) is here specifically to browse
  // ANY department's history, not just their own assigned one, so
  // this always uses allLocations rather than the staff member's own
  // locations — unlike Credit/Recovery, there's no bar/front_desk
  // access to this page that would need staying department-scoped.
  const salesPoints = (allLocations || []).filter(l => l.is_sales_point && !l.is_store)
  const toast = useToast()

  const [date, setDate] = useState(lagosToday())
  const [locId, setLocId] = useState('all')
  const [summary, setSummary] = useState(null)
  // The day's detail, folded into the tile (17 October 2026). Same
  // component as the Sales page, so the two cannot drift apart.
  const [detailOpen, setDetailOpen] = useState(false)
  const [writeoffs, setWriteoffs] = useState(null)
  // Duplicate customers and guests already have a finder on Corrections,
  // but nobody goes looking — which is how "General manager" came back
  // months after the first merge. A count where the GM already looks
  // every day turns that into days rather than months.
  const [dupeCount, setDupeCount] = useState(0)
  const [rows, setRows] = useState(null)
  const [receptionActivity, setReceptionActivity] = useState(null)
  const [receptionDashboard, setReceptionDashboard] = useState(null)
  const [roomCharges, setRoomCharges] = useState([])
  const [roomsSold, setRoomsSold] = useState(null)
  const [showYesterday, setShowYesterday] = useState(false)
  const [yesterdaySummary, setYesterdaySummary] = useState(null)
  const [yesterdayActivity, setYesterdayActivity] = useState(null)

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries(salesPoints.map(l => [l.id, l])), [salesPoints])
  const isReception = /reception/i.test(salesPoints.find(l => l.id === locId)?.name || '')
  // Internal rooms (GM Office, via rooms.is_internal) and the
  // monthly rooms-sold count are both
  // GM/admin-only visibility on this dashboard — matches
  // is_supervisor()'s own role set, not the broader oversight group.
  const isGmOrAdmin = is(staff.role, SUPERVISOR)

  // Reset to "All departments" on branch switch (GM/admin) — otherwise
  // the old branch's department id stays selected, matching no chip
  // here, so filtering silently breaks until a manual tap.
  useEffect(() => {
    setLocId('all')
  }, [staff.branch_id])

  // "Yesterday" here means the day before the date being BROWSED, not
  // always literal yesterday — on this page the date is a control, so
  // anchoring to lagosToday() would be wrong the moment someone looks
  // back. Lazy: nothing is fetched until the section is opened.
  const priorDay = lagosDaysAgo(1, date)
  useEffect(() => {
    if (!isReception || !showYesterday) return
    setYesterdaySummary(null); setYesterdayActivity(null)
    loadDailyFinancials(staff.branch_id, priorDay, locId === 'all' ? null : locId)
      .then(setYesterdaySummary).catch(() => {})
    loadReceptionActivity(staff.branch_id, priorDay)
      .then(setYesterdayActivity).catch(() => {})
  }, [isReception, showYesterday, staff.branch_id, priorDay, locId])
  // Room charges are resolved per line by department now, not by category
  // (migration 503). Category could not tell MainBar from OpenBar — both
  // are 'drink' — and "All" had no single category at all, so it showed
  // no room charges whatsoever.
  const showsRoomCharges = !isReception

  const refresh = useCallback(() => {
    const loc = locId === 'all' ? null : locId
    setSummary(null); setRows(null); setReceptionActivity(null); setRoomCharges([]); setReceptionDashboard(null); setRoomsSold(null)
    setWriteoffs(null)
    if (isGmOrAdmin) {
      Promise.all([
        findDuplicateCustomers(staff.branch_id).catch(() => []),
        findDuplicateGuests(staff.branch_id).catch(() => []),
      ]).then(([c, g]) => setDupeCount((c?.length || 0) + (g?.length || 0)))
        .catch(() => setDupeCount(0))
    }
    // Loaded BEFORE the Reception branch below, which returns early —
    // otherwise the breakdown would vanish on the Reception tab. On
    // failure, record the error so the section says so rather than
    // silently showing nothing.
    loadWriteoffsOnDate(staff.branch_id, date, loc)
      .then(r => setWriteoffs({ ...r, error: null }))
      .catch(e => setWriteoffs({ pr: [], damage: [], food: [], prCost: 0, damageCost: 0,
                                 foodValue: 0, error: e.message || 'could not load' }))
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
    // Debt recovered also includes what guests paid at this department
    // against their room charges (e.g. "charge to a room" settled at MainBar).
    Promise.all([
      loadDailyFinancials(staff.branch_id, date, loc),
      loadRoomBillHandover(staff.branch_id, date).catch(() => []),
      // Whole branch only — see withStayDebt. Null on failure so a
      // database that has not had 565 run yet still shows the day.
      // From 1 November this is replaced by nights-as-sales and its own
      // recovery. Adding both would count the same naira twice.
      (locId === 'all' && date < NIGHTS_AS_SALES_FROM)
        ? loadStayDebtRecovered(staff.branch_id, date).catch(() => null)
        : Promise.resolve(null),
      (date >= NIGHTS_AS_SALES_FROM && (locId === 'all' || isReception))
        ? loadReceptionRoomSales(staff.branch_id, date).catch(() => null)
        : Promise.resolve(null),
      (date >= NIGHTS_AS_SALES_FROM && (locId === 'all' || isReception))
        ? loadRoomDebtRecovered(staff.branch_id, date).catch(() => null)
        : Promise.resolve(null),
    ]).then(([f, hand, stayDebt, nights, roomRec]) =>
      setSummary(withRoomNights(withStayDebt(withRoomBillMoney(f,
        locId === 'all' ? hand
          : hand.filter(h => roomChargeDept(h, allLocations) === locId)), stayDebt),
        nights, roomRec)))
      .catch(e => toast(e.message, 'error'))
    loadToday(staff.branch_id, date, loc).then(setRows).catch(e => toast(e.message, 'error'))
    if (showsRoomCharges) {
      loadRoomCharges(staff.branch_id, date).then(setRoomCharges).catch(e => toast(e.message, 'error'))
    }
  }, [staff.branch_id, date, locId, isReception, showsRoomCharges])
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
    if (!showsRoomCharges) return sales
    // Only this department's own charges; "All" keeps every one of them.
    const mine = locId === 'all' ? roomCharges
      : roomCharges.filter(r => roomChargeDept(r, allLocations) === locId)
    const charges = mine.map(r => ({
      ...r, entryKind: 'roomCharge', sortAt: r.orders?.created_at,
      roomNumber: r.orders?.stays?.rooms?.room_number, guestName: r.orders?.stays?.guests?.full_name,
      chargedBy: r.orders?.served?.full_name,
      folioOutstanding: r.folioOutstanding, stayStatus: r.stayStatus, lineStatus: r.lineStatus,
    }))
    return [...sales, ...charges].sort((a, b) => (b.sortAt || '').localeCompare(a.sortAt || ''))
  }, [rows, roomCharges, showsRoomCharges, locId, allLocations])

  // What this department charged to rooms today. In the day's total at
  // the top of the page but NOT in gross sales — a room charge is not
  // money at this till — so it is named here rather than left as an
  // unexplained gap between two figures on one screen.
  const roomChargedToday = combinedRows
    .filter(r => r.entryKind === 'roomCharge' && r.order_type !== 'pr_damage')
    .reduce((t, r) => t + Number(r.amount ?? r.qty * r.unit_price ?? 0), 0)

  const total = combinedRows.reduce((s, r) => s + Number(r.amount ?? r.qty * r.unit_price), 0)

  // Stepping back a day is what this page is opened to do, and it took
  // opening a date picker and finding yesterday in a calendar grid every
  // time (19 October 2026). Arrows do it in one tap; the date box is
  // still there for a day further off.
  const shiftDay = (by) => {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() + by)
    const next = d.toISOString().slice(0, 10)
    if (next > lagosToday()) return
    setDate(next)
  }
  const isToday = date === lagosToday()
  const dayName = isToday ? 'Today'
    : date === lagosDaysAgo(1) ? 'Yesterday'
    : new Date(date + 'T12:00:00').toLocaleDateString('en-NG',
        { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="px-5">
      <div className="flex items-center gap-2 mt-1 mb-2">
        <button onClick={() => shiftDay(-1)} aria-label="The day before"
          className="h-12 w-12 shrink-0 rounded-xl bg-surface border border-line text-xl font-bold">
          ‹
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="font-bold truncate">{dayName}</div>
          <div className="text-dim text-xs tnum">{date}</div>
        </div>
        <button onClick={() => shiftDay(1)} disabled={isToday} aria-label="The day after"
          className="h-12 w-12 shrink-0 rounded-xl bg-surface border border-line text-xl font-bold disabled:opacity-30">
          ›
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input type="date" value={date} max={lagosToday()}
          onChange={e => {
            const v = e.target.value
            if (!v) return
            if (v > lagosToday()) { setDate(lagosToday()); return }
            setDate(v)
          }}
          className={`h-12 px-3 rounded-xl bg-surface border tnum ${
            isToday ? 'border-line' : 'border-amber text-amber'}`} />
        {/* One word: "Back to today" wrapped to two lines beside the
            date box at 320px, and the stepper above already names the
            day. */}
        {!isToday && (
          <button onClick={() => setDate(lagosToday())}
            className="h-12 px-4 shrink-0 rounded-xl border border-amber text-amber text-sm font-semibold">
            Today
          </button>
        )}
      </div>

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
              <span className="text-xs"> · one per room per night</span>
            </p>
          )}
          {/* showRoomsSold is false here: rooms sold renders above,
              outside this block, so it still shows for past dates.
              Folded into the same tile every other department uses, so
              Reception's day reads as three figures here too. */}
          {receptionDashboard && (
            <TillTile title="Close of day" open={detailOpen}
              onToggle={() => setDetailOpen(o => !o)}
              figures={[
                { label: 'POS', value: receptionDashboard.pos },
                { label: 'Cash', value: receptionDashboard.cash },
                // Clay, as it was: this is what guests owe, not money in.
                { label: 'Credit', value: receptionDashboard.deferredTotal, tone: 'text-clay' },
              ]}>
              <ReceptionDashboard dashboard={receptionDashboard} headless className=""
                canSeeInternal={isGmOrAdmin} />
            </TillTile>
          )}
          {date !== lagosToday() && (
            <p className="text-dim text-sm mt-4">
              Deferred and advance figures only show for today — they reflect current
              balances, not a snapshot of {date}.
            </p>
          )}

          <div className="mt-3">
            <button onClick={() => setShowYesterday(x => !x)}
              className="w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
              {showYesterday ? 'Hide' : 'Show'} the day before ({priorDay})
            </button>
            {showYesterday && (
              <div className="mt-2 rounded-2xl border border-line bg-surface p-4">
                {yesterdaySummary ? (
                  <div className="grid grid-cols-3 gap-3 pb-3 mb-3 border-b border-line">
                    <div>
                      <div className="text-dim text-sm">POS</div>
                      <div className="tnum font-bold">{naira((yesterdaySummary.byMethod || {}).pos || 0)}</div>
                    </div>
                    <div>
                      <div className="text-dim text-sm">Cash</div>
                      <div className="tnum font-bold">{naira((yesterdaySummary.byMethod || {}).cash || 0)}</div>
                    </div>
                    <div>
                      <div className="text-dim text-sm">Credit raised</div>
                      <div className="tnum font-bold text-clay">{naira(yesterdaySummary.creditRaised)}</div>
                    </div>
                  </div>
                ) : <p className="text-dim text-sm">Loading…</p>}

                <p className="text-dim text-sm mb-1">Payments collected</p>
                {(yesterdayActivity || []).map(p2 => (
                  <div key={p2.id} className="flex justify-between text-sm py-1 border-b border-line/60 last:border-0">
                    <span className="truncate">
                      {p2.stays?.guests?.full_name || 'Guest'} · Room {p2.stays?.rooms?.room_number || '—'}
                      <span className="text-dim"> · {methodLabel[p2.method] || p2.method}</span>
                    </span>
                    <span className="tnum font-semibold">{naira(p2.amount)}</span>
                  </div>
                ))}
                {yesterdayActivity && !yesterdayActivity.length && (
                  <p className="text-dim text-sm">No payments that day.</p>
                )}
                {!yesterdayActivity && <p className="text-dim text-sm">Loading…</p>}
              </div>
            )}
          </div>

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
        <TillTile title="The day's sales" open={detailOpen} onToggle={() => setDetailOpen(o => !o)}
          figures={['pos', 'cash', 'credit'].map(m => ({
            label: methodLabel[m] || m, value: (summary.byMethod || {})[m] || 0 }))}>
        <div>
          <div className="text-dim text-sm">Gross sales — value of goods sold</div>
          <div className="tnum text-3xl font-bold text-amber">{naira(summary.grossSales)}</div>
          <div className="mt-3 space-y-1 text-sm">
            {summary.roomNights && summary.roomNights.total > 0.009 && (
              <div className="flex justify-between gap-3">
                <span className="text-dim min-w-0">
                  Room nights &mdash; {summary.roomNights.rows?.length || 0} room
                  {(summary.roomNights.rows?.length || 0) === 1 ? '' : 's'} slept and paid for
                </span>
                <span className="tnum shrink-0 text-amber">{naira(summary.roomNights.total)}</span>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <span className="text-dim min-w-0">Received (POS + Cash)</span>
              <span className="tnum shrink-0">{naira(summary.received)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-dim min-w-0">Credit raised</span>
              <span className={`tnum shrink-0 ${summary.creditRaised > 0 ? 'text-clay' : ''}`}>{naira(summary.creditRaised)}</span>
            </div>
            {summary.unqualifiedCredit > 0 && (
              <div className="flex justify-between gap-3 text-clay">
                <span className="min-w-0">Not repaid by noon next day — excluded from sales above</span>
                <span className="tnum shrink-0">{naira(summary.unqualifiedCredit)}</span>
              </div>
            )}
            {/* ONE heading, because a customer paying off an account
                and a guest paying off a room bill are the same thing
                (531). Debt recovered already carries both — listing
                room bills again underneath showed the same money twice
                on this page, which is exactly the two-panels-one-day
                drift that started all this. */}
            <div className="flex justify-between gap-3">
              <span className="text-dim min-w-0">Debt recovered</span>
              <span className="tnum text-leaf shrink-0">{naira(summary.debtRecovered)}</span>
            </div>
            {summary.recoveredFromCustomers > 0 && (
              <>
                <SubLine label="· from customer accounts" value={summary.recoveredFromCustomers} />
                <ByMethod map={summary.customerRecoveredBy} labels={methodLabel} />
              </>
            )}
            {summary.recoveredFromRooms > 0 && (
              <>
                <SubLine label="· from guests' room bills" value={summary.recoveredFromRooms} />
                <ByMethod map={summary.roomRecoveredBy} labels={methodLabel} />
                {/* Who paid what — the GM's page keeps the names. */}
                <div className="pl-4 pt-1 text-sm">
                  {summary.roomBill.map((r, i) => (
                    <div key={i} className="flex justify-between gap-3">
                      <span className="text-dim truncate min-w-0">
                        · {r.guest || 'Guest'}{r.room ? ` (Room ${r.room})` : ''} · {r.charge || 'charge'}
                      </span>
                      <span className="tnum text-dim shrink-0">{naira(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {summary.stayDebt && (
              <>
                <SubLine label="· from room bills paid after check-out"
                  value={summary.stayDebt.total} />
                <ByMethod map={summary.stayDebt.byMethod} labels={methodLabel} />
                <div className="pl-4 pt-1 text-sm">
                  {summary.stayDebt.rows.map((r, i) => (
                    <div key={i} className="flex justify-between gap-3">
                      <span className="text-dim truncate min-w-0">
                        · {r.guest || 'Guest'}{r.room ? ` (Room ${r.room})` : ''} · left {r.left}
                      </span>
                      <span className="tnum text-dim shrink-0">{naira(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {roomChargedToday > 0 && (
              <>
                <div className="flex justify-between gap-3">
                  <span className="text-dim min-w-0">Credit given to guests&#39; rooms today</span>
                  <span className="tnum text-dim shrink-0">{naira(roomChargedToday)}</span>
                </div>
                <p className="text-dim text-xs pl-4">
                  Goods that left on a guest&#39;s room bill — credit given to the guest, not
                  money. It comes back as debt recovered on the day they pay at Reception.
                </p>
              </>
            )}
            <div className="pt-2 mt-2 border-t border-line flex justify-between gap-3 font-bold">
              <span className="min-w-0">Total income for the day</span>
              <span className="tnum shrink-0">{naira(summary.totalMoneyIn)}</span>
            </div>
          </div>
          {/* The old totals-only block was here; the itemised
              breakdown is shared with Sales so the two pages
              cannot drift apart again. */}
          <WriteoffBreakdown data={writeoffs} settled={summary} />

          {/* What was undone to this day afterwards. Sits with the day's
              figures on purpose: a total and the corrections made to it
              only mean something read together. */}
          <CorrectionsOnDay branchId={staff.branch_id} date={date}
            locationId={locId === 'all' ? null : locId} />

        </div>
        </TillTile>
      )}

      {/* Outside the fold on purpose: a warning nobody opens the detail
          to find is a warning nobody sees. */}
      {isGmOrAdmin && dupeCount > 0 && (
        <Notice tone="warn" className="mt-3"
          title={`${dupeCount} possible duplicate ${dupeCount === 1 ? 'record' : 'records'}`}>
          <p className="text-dim text-sm mt-1">
            Two records for one person split their debt in two. Review them
            under More → Corrections → Reception.
          </p>
        </Notice>
      )}

      {!isReception && (
        <RoomChargeTracker branchId={staff.branch_id} locationId={locId === 'all' ? null : locId} />
      )}

      {!isReception && (
        <StockUsedReport branchId={staff.branch_id} date={date} locationId={locId === 'all' ? null : locId} />
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
                  <br />Charged by {r.chargedBy || 'unknown'}
                  {r.sortAt ? ` · ${new Date(r.sortAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}` : ''}
                  {/* A meal on this list means the food left the kitchen,
                      not that anyone paid. Payment sits against the whole
                      stay, so this is the GUEST'S BILL, not this line. */}
                  {r.lineStatus ? (
                    <>
                      <br />
                      {{ settled: <span className="text-leaf">Guest's bill is settled</span>,
                         running: <span className="text-amber">On the running bill</span>,
                         debt: <span className="text-clay font-bold">Unpaid — guest has checked out</span>,
                      }[r.lineStatus]}
                    </>
                  ) : r.folioOutstanding != null && (
                    <>
                      <br />
                      {r.folioOutstanding > 0.009
                        ? <span className={r.stayStatus === 'checked_out' ? 'text-clay font-bold' : 'text-clay'}>
                            {r.stayStatus === 'checked_out'
                              ? `Checked out still owing ${naira(r.folioOutstanding)}`
                              : `${naira(r.folioOutstanding)} still on this guest's bill`}
                          </span>
                        : <span className="text-leaf">Guest's bill settled</span>}
                    </>
                  )}
                </div>
              ) : (
                <div className="text-dim text-sm">
                  {tierLabel[r.tier] || r.tier} · {r.qty} × {naira(r.unit_price)}
                  {locId === 'all' && locById[r.location_id] ? ` · ${locById[r.location_id].name}` : ''}
                  <br />{paymentSummary(r)} · {whoRecorded(r)}
                </div>
              )}
              {!!r.order_stock_used?.length && (
                <div className="text-dim text-sm">
                  Stock used: {r.order_stock_used.map(u => `${Number(u.qty)} × ${u.stock_items?.name || 'item'}`).join(', ')}
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
