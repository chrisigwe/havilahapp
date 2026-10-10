import { useEffect, useState } from 'react'
import { naira, lagosToday, lagosTime, seesStayTimes, addDays } from '../lib/format'
import {
  checkInReservation, loadCheckoutsStillOwing, loadOccupancy, setRoomServiceStatus, loadUpcomingReservations,
} from '../lib/data'
import CheckIn from './CheckIn'
import Folio from '../components/Folio'
import ReopenSearch from '../components/ReopenSearch'
import { useToast } from '../components/Toast'
import { is, MANAGEMENT } from '../lib/roles'

// Phase 2 of bringing the front-desk app's functionality into this
// one: check-in and new bookings, alongside the view-only room status
// from phase 1. Folio, checkout, and settling a stay's bill are still
// in the separate front-desk app for now.
const STATE = {
  vacant:   { label: 'Vacant',      bar: 'bg-line',  text: 'text-dim' },
  occupied: { label: 'Occupied',    bar: 'bg-leaf',  text: 'text-leaf' },
  reserved: { label: 'Reserved',    bar: 'bg-amber', text: 'text-amber' },
  reserved_due: { label: 'Reserved — due',  bar: 'bg-clay',  text: 'text-clay' },
  overdue:  { label: 'Past due',    bar: 'bg-clay',  text: 'text-clay' },
  service:  { label: 'Maintenance', bar: 'bg-dim',   text: 'text-dim' },
}

function stateOf(room) {
  if (room.out_of_service) return 'service'
  if (!room.stay_id) return 'vacant'
  if (room.is_overdue) return 'overdue'
  if (room.status === 'reserved') {
    // The whole point of letting a future reservation not block the
    // room early is that staff still need a clear, unmissable signal
    // once its actual date arrives — this is that signal.
    return room.check_in_date <= lagosToday() ? 'reserved_due' : 'reserved'
  }
  return 'occupied'
}

const shortDate = d => new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })

// "Booked: Name from 12 Oct" on a room that has a reservation OTHER than the
// stay the card is already showing (vacant room with a later booking, or an
// occupied room someone has reserved for after the current guest leaves).
function NextBooking({ room, reservations }) {
  const next = reservations.find(r => r.roomId === room.room_id && r.stayId !== room.stay_id)
  if (!next) return null
  return (
    <p className="text-amber text-xs font-semibold mt-1">
      Booked: {next.guest} from {shortDate(next.checkIn)}
    </p>
  )
}

export default function RoomBoard({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const canManageRooms = is(staff.role, MANAGEMENT)
  // Arrival/departure clock times are for oversight only — front
  // desk and bar keep seeing the dates exactly as before.
  const showTimes = seesStayTimes(staff.role)
  // Auditors were added to this page so they can SEE arrival times;
  // they must not gain the ability to create bookings with it. Phrased
  // as "not auditor" rather than an allow-list so no existing role
  // quietly loses booking rights it already had.
  const canBook = staff.role !== 'auditor'
  const [checkingIn, setCheckingIn] = useState(false)
  const [openStay, setOpenStay] = useState(null)   // the room whose folio is open
  const [reopenSearching, setReopenSearching] = useState(false)
  // Checked-out guests who still owe, no time limit — so a debt does
  // not quietly fall off "Recently checked out" after 14 days.
  const [owingCheckouts, setOwingCheckouts] = useState([])
  useEffect(() => {
    loadCheckoutsStillOwing(staff.branch_id).then(setOwingCheckouts).catch(() => setOwingCheckouts([]))
  }, [staff.branch_id, openStay])  // openStay: refetch after a payment is recorded
  const [markingOOS, setMarkingOOS] = useState(null)   // the room being marked out of service
  const [oosReason, setOosReason] = useState('')
  const [oosBusy, setOosBusy] = useState(false)
  const [rooms, setRooms] = useState(null)

  // Every reservation not yet arrived, so a room that looks free (or is
  // occupied right now) still shows that someone has booked it later.
  const [reservations, setReservations] = useState([])
  const refresh = () => {
    loadOccupancy(staff.branch_id).then(setRooms).catch(() => setRooms([]))
    loadUpcomingReservations(staff.branch_id).then(setReservations).catch(() => setReservations([]))
  }
  useEffect(refresh, [staff.branch_id])

  async function confirmMarkOOS() {
    setOosBusy(true)
    try {
      await setRoomServiceStatus(markingOOS.room_id, true, oosReason)
      toast(`Room ${markingOOS.room_number} marked out of service`, 'success')
      setMarkingOOS(null); setOosReason(''); refresh()
    } catch (e) { toast(e.message, 'error') }
    setOosBusy(false)
  }

  async function markBackInService(room) {
    setOosBusy(true)
    try {
      await setRoomServiceStatus(room.room_id, false)
      toast(`Room ${room.room_number} back in service`, 'success')
      refresh()
    } catch (e) { toast(e.message, 'error') }
    setOosBusy(false)
  }

  async function checkInNow(room) {
    setOosBusy(true)
    try {
      await checkInReservation(room.stay_id)
      toast(`Room ${room.room_number} · ${room.guest_name} checked in`, 'success')
      refresh()
    } catch (e) { toast(e.message, 'error') }
    setOosBusy(false)
  }

  if (rooms === null) return <p className="px-5 text-dim">Loading…</p>

  const tally = rooms.reduce((acc, r) => {
    const s = stateOf(r); acc[s] = (acc[s] || 0) + 1; return acc
  }, {})
  const owed = rooms.reduce((s, r) => s + Math.max(Number(r.outstanding || 0), 0), 0)
  const onDeposit = rooms.reduce((s, r) => s + Math.max(-Number(r.outstanding || 0), 0), 0)

  return (
    <div className="px-5">
      {!!rooms.length && (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 py-3 border-b border-line mb-3">
          {Object.entries(STATE).map(([key, s]) => (
            <span key={key} className="text-dim text-sm">
              <b className={`text-lg font-bold tnum ${s.text}`}>{tally[key] || 0}</b> {s.label.toLowerCase()}
            </span>
          ))}
          {owed > 0 && (
            <span className="text-dim text-sm ml-auto">
              <b className="text-lg font-bold tnum text-clay">{naira(owed)}</b> outstanding
            </span>
          )}
          {onDeposit > 0 && (
            <span className="text-dim text-sm">
              <b className="text-lg font-bold tnum text-leaf">{naira(onDeposit)}</b> on deposit
            </span>
          )}
        </div>
      )}

      {canBook && (
        <button onClick={() => setCheckingIn(true)}
          className="w-full h-14 rounded-2xl border-2 border-amber text-amber text-lg font-bold mb-3">
          + New booking
        </button>
      )}

      <button onClick={() => setReopenSearching(true)}
        className="w-full h-12 rounded-xl border border-line text-ink font-semibold mb-4">
        Recently checked out
      </button>

      {/* Opens the same folio "Recently checked out" does — payment can
          already be recorded on it without reopening the stay. */}
      {!!owingCheckouts.length && (
        <div className="mb-4 rounded-2xl border-2 border-clay bg-clay/10 p-4">
          <p className="text-clay font-bold">
            {owingCheckouts.length} guest{owingCheckouts.length === 1 ? '' : 's'} checked out
            still owing
          </p>
          <div className="mt-2 space-y-2">
            {owingCheckouts.map(g => (
              <button key={g.stay_id} onClick={() => setOpenStay({
                  // Matches what ReopenSearch's onPick supplies — that is
                  // what Folio actually reads (room.stay_id, not .id).
                  stay_id: g.stay_id, room_number: g.room_number, guest_name: g.guest_name,
                  status: 'checked_out', actual_out: g.actual_out,
                })}
                className="w-full flex items-center justify-between gap-2 text-left">
                <span className="text-clay text-sm truncate">
                  Room {g.room_number || '—'} · {g.guest_name || 'Guest'}
                  <span className="text-dim"> · left {g.actual_out}</span>
                  {g.billed_to && <span className="text-dim"> · billed to {g.billed_to}</span>}
                </span>
                <span className="tnum font-bold text-clay shrink-0">{naira(g.outstanding)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!rooms.length && <p className="py-8 text-center text-dim">No rooms set up for this branch yet.</p>}

      {(() => {
        const today = lagosToday()
        const due = reservations.filter(r => r.checkIn <= today)
        const soon = reservations.filter(r => r.checkIn > today && r.checkIn <= addDays(today, 7))
        if (!due.length && !soon.length) return null
        const line = r => (
          <p key={r.stayId} className="text-sm">
            <b>Room {r.roomNumber}</b> — {r.guest}
            <span className="text-dim"> · {r.checkIn <= today ? (r.checkIn === today ? 'today' : 'since ' + shortDate(r.checkIn))
              : r.checkIn === addDays(today, 1) ? 'tomorrow' : shortDate(r.checkIn)}
              {' → out '}{shortDate(r.scheduledOut)}</span>
          </p>
        )
        return (
          <div className="mb-4 space-y-3">
            {!!due.length && (
              <div className="rounded-2xl border-2 border-clay bg-clay/10 p-4 text-clay">
                <p className="font-bold">
                  {due.length} reservation{due.length === 1 ? '' : 's'} due — keep {due.length === 1 ? 'this room' : 'these rooms'} free
                </p>
                <div className="mt-2 space-y-1">{due.map(line)}</div>
              </div>
            )}
            {!!soon.length && (
              <div className="rounded-2xl border border-amber bg-amber/10 p-4 text-amber">
                <p className="font-bold">Upcoming reservations — do not sell these rooms for the dates shown</p>
                <div className="mt-2 space-y-1">{soon.map(line)}</div>
              </div>
            )}
          </div>
        )
      })()}

      <div className="grid grid-cols-2 gap-3">
        {rooms.map(room => {
          const stateKey = stateOf(room)
          const s = STATE[stateKey]
          return (
            <div key={room.room_id}
              onClick={() => room.stay_id && setOpenStay(room)}
              className={`rounded-2xl border border-line bg-surface overflow-hidden flex ${room.stay_id ? 'cursor-pointer active:opacity-70' : ''}`}>
              <div className={`w-1.5 shrink-0 ${s.bar}`} />
              <div className="px-3 py-3 min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xl font-bold tnum">{room.room_number}</span>
                  <span className={`text-xs font-semibold ${s.text}`}>{s.label}</span>
                </div>
                <p className="text-dim text-xs mt-0.5 truncate">{room.category}</p>

                {room.out_of_service ? (
                  <>
                    <p className="text-dim text-sm mt-2 truncate">{room.oos_reason || 'Out of service'}</p>
                    {canManageRooms && (
                      <button onClick={(e) => { e.stopPropagation(); markBackInService(room) }}
                        disabled={oosBusy}
                        className="mt-2 h-8 px-3 rounded-lg border border-leaf text-leaf text-sm font-semibold disabled:opacity-40">
                        Back in service
                      </button>
                    )}
                  </>
                ) : room.guest_name ? (
                  <>
                    <p className="text-sm font-semibold mt-2 truncate">{room.guest_name}</p>
                    {showTimes && room.checked_in_at && stateKey !== 'reserved'
                      && stateKey !== 'reserved_due' && (
                      <p className="text-dim text-xs tnum mt-0.5">in {lagosTime(room.checked_in_at)}</p>
                    )}
                    {stateKey === 'reserved_due' && (
                      <p className="text-clay text-xs font-bold mt-0.5">
                        Reserved for {room.check_in_date === lagosToday() ? 'today' : 'since ' +
                          new Date(room.check_in_date + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                        — keep it free
                      </p>
                    )}
                    {stateKey === 'reserved_due' && canBook && (
                      <button onClick={(e) => { e.stopPropagation(); checkInNow(room) }} disabled={oosBusy}
                        className="mt-2 h-9 px-3 rounded-lg bg-amber text-bg text-sm font-bold disabled:opacity-40">
                        Guest arrived — check in now
                      </button>
                    )}
                    {stateKey === 'reserved' && (
                      <p className="text-dim text-xs mt-0.5">
                        from {new Date(room.check_in_date + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                      </p>
                    )}
                    <p className="text-dim text-xs tnum mt-0.5">
                      out {new Date(room.scheduled_out + 'T12:00:00').toLocaleDateString('en-NG',
                        { day: 'numeric', month: 'short' })}
                      {room.remaining_nights != null && room.remaining_nights >= 0
                        && ` · ${room.remaining_nights}n left`}
                    </p>
                    {Number(room.outstanding) > 0 && (
                      <p className="text-clay text-xs font-semibold mt-0.5">{naira(room.outstanding)} due</p>
                    )}
                    {Number(room.outstanding) < 0 && (
                      <p className="text-leaf text-xs font-semibold mt-0.5">{naira(-room.outstanding)} left</p>
                    )}
                    {room.bill_to && (
                      <p className="text-amber text-xs font-semibold mt-0.5 truncate">→ {room.bill_to}</p>
                    )}
                    <NextBooking room={room} reservations={reservations} />
                  </>
                ) : (
                  <>
                    <p className="text-dim text-sm mt-2">Ready to let</p>
                    <NextBooking room={room} reservations={reservations} />
                    {canManageRooms && (
                      <button onClick={(e) => { e.stopPropagation(); setMarkingOOS(room); setOosReason('') }}
                        className="mt-2 h-8 px-3 rounded-lg border border-clay text-clay text-sm font-semibold">
                        Mark out of service
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {checkingIn && (
        <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
          <div className="p-5 pb-2">
            <button onClick={() => setCheckingIn(false)} className="text-dim">Close</button>
          </div>
          <CheckIn boot={boot} onDone={() => { setCheckingIn(false); refresh() }} />
        </div>
      )}

      {openStay && (
        <Folio boot={boot} room={openStay}
          onClose={() => setOpenStay(null)}
          onChanged={refresh} />
      )}

      {reopenSearching && (
        <ReopenSearch boot={boot}
          onClose={() => setReopenSearching(false)}
          onPick={(stayLike) => { setReopenSearching(false); setOpenStay(stayLike) }} />
      )}

      {markingOOS && (
        <div className="fixed inset-0 z-50 bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Mark Room {markingOOS.room_number} out of service?</h2>
          <p className="text-dim mt-2">It won't be selectable for new bookings until brought back.</p>
          <label className="block mt-4 text-dim">Reason (optional)</label>
          <input value={oosReason} onChange={e => setOosReason(e.target.value)} autoFocus
            placeholder="e.g. AC repair, plumbing fault"
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
          <button onClick={confirmMarkOOS} disabled={oosBusy}
            className="mt-6 w-full h-16 rounded-2xl bg-clay text-bg text-xl font-bold disabled:opacity-40">
            {oosBusy ? 'Saving…' : 'Mark out of service'}
          </button>
          <button onClick={() => setMarkingOOS(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}
