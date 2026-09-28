import { naira } from '../lib/format'

// The Reception close-of-day dashboard: POS/cash, deferred balances,
// room-rate progress, and the in-house roster.
//
// Previously copied inline into BOTH SalesEntry and DailySales, where
// the two copies had already started to drift. One component now, so
// a fix lands in both places at once.
//
// The two pages differ in exactly one respect, which is why
// showRoomsSold exists: on Sales the rooms-sold line sits inside the
// dashboard, but Daily Sales renders it OUTSIDE, because there it must
// still show for past dates when this dashboard (current balances
// only) is hidden. Daily Sales therefore passes showRoomsSold={false}.
export default function ReceptionDashboard({
  dashboard, canSeeInternal, roomsSold, showRoomsSold = false, className = 'mt-3',
}) {
  if (!dashboard) return null

  // Internal rooms (GM Office, via rooms.is_internal) are visible only
  // to gm/admin. Computed here rather than in each page, since both
  // pages derived it identically and used it for nothing else.
  const roomRateProgress = (dashboard.roomRateProgress || [])
    .filter(r => canSeeInternal || !r.is_internal)
  const roomRateRemainingTotal = roomRateProgress.reduce((s, r) => s + r.remaining, 0)

  return (
    <div className={`${className} rounded-2xl border border-amber bg-surface p-4`}>
      <p className="font-semibold">Close of day</p>
      <div className="grid grid-cols-3 gap-3 mt-3 pb-3 border-b border-line">
        <div>
          <div className="text-dim text-sm">POS</div>
          <div className="tnum font-bold">{naira(dashboard.pos)}</div>
        </div>
        <div>
          <div className="text-dim text-sm">Cash</div>
          <div className="tnum font-bold">{naira(dashboard.cash)}</div>
        </div>
        <div>
          <div className="text-dim text-sm">Credit</div>
          <div className="tnum font-bold text-clay">{naira(dashboard.deferredTotal)}</div>
        </div>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-dim">Deferred — owed across every live stay</span>
        <span className="tnum font-bold text-clay">{naira(dashboard.deferredTotal)}</span>
      </div>
      <div className="mt-1 space-y-1">
        {dashboard.deferred.map(g => (
          <div key={g.stay_id} className="flex justify-between text-sm">
            <span className="text-dim truncate">{g.guest_name || 'Guest'} · Room {g.room_number}</span>
            <span className="tnum">{naira(g.outstanding + g.departmentCredit + g.billedToYou)}</span>
          </div>
        ))}
        {!dashboard.deferred.length && (
          <p className="text-dim text-sm">Nothing deferred right now.</p>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-line flex items-baseline justify-between">
        <span className="text-dim">Room rate — period progress</span>
        <span className="tnum font-bold text-leaf">{naira(roomRateRemainingTotal)} left</span>
      </div>
      {showRoomsSold && roomsSold != null && (
        <p className="text-dim text-sm mt-0.5">{roomsSold} room{roomsSold === 1 ? '' : 's'} sold this month</p>
      )}
      <div className="mt-1 space-y-2">
        {roomRateProgress.map(r => (
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
        {!roomRateProgress.length && (
          <p className="text-dim text-sm">No multi-night stays right now.</p>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-line flex items-baseline justify-between">
        <span className="text-dim">In-house today — every occupied room</span>
        <span className="tnum font-bold">{dashboard.inHouse.length}</span>
      </div>
      <p className="text-dim text-xs mt-0.5">
        Everyone stays listed here whether they paid, are on credit, or had no
        activity today — nobody drops off this list just for not transacting.
      </p>
      <div className="mt-2 space-y-1.5">
        {dashboard.inHouse.map(g => (
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
        {!dashboard.inHouse.length && (
          <p className="text-dim text-sm">No occupied rooms right now.</p>
        )}
      </div>
    </div>
  )
}
