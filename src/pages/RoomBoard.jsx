import { useEffect, useState } from 'react'
import { naira, lagosToday, lagosTime, seesStayTimes } from '../lib/format'
import {
  checkInReservation, loadCheckoutsStillOwing, loadInternalRoomIds, loadOccupancy,
  loadPaidThrough, setRoomServiceStatus, loadUpcomingReservations,
} from '../lib/data'
import CheckIn from './CheckIn'
import Folio from '../components/Folio'
import ReopenSearch from '../components/ReopenSearch'
import { useToast } from '../components/Toast'
import { is, MANAGEMENT, SUPERVISOR } from '../lib/roles'

// Phase 2 of bringing the front-desk app's functionality into this
// one: check-in and new bookings, alongside the view-only room status
// from phase 1. Folio, checkout, and settling a stay's bill are still
// in the separate front-desk app for now.
const STATE = {
  vacant:   { label: 'Vacant',      bar: 'bg-line',  text: 'text-dim' },
  occupied: { label: 'Occupied',    bar: 'bg-leaf',  text: 'text-leaf' },
  reserved_due: { label: 'Reserved — due',  bar: 'bg-clay',  text: 'text-clay' },
  overdue:  { label: 'Past due',    bar: 'bg-clay',  text: 'text-clay' },
  leaving:  { label: 'Leaving today', bar: 'bg-amber', text: 'text-amber' },
  service:  { label: 'Maintenance', bar: 'bg-dim',   text: 'text-dim' },
}

// Grouped by what needs doing, and inside each group the rooms run in
// building order: 101, 102, 103. The first attempt had the grouping
// without the headings, so a board that opened on 207 looked shuffled
// rather than sorted — the heading is what makes the order read as a
// reason instead of a mistake.
const ORDER = ['overdue', 'reserved_due', 'leaving', 'occupied', 'vacant', 'service']
const SECTION = {
  overdue:      { title: 'Past due — ask or check out', tone: 'text-clay' },
  reserved_due: { title: 'Reserved — due today',        tone: 'text-clay' },
  leaving:      { title: 'Leaving today',               tone: 'text-amber' },
  occupied:     { title: 'In house',                    tone: 'text-dim' },
  vacant:       { title: 'Ready to let',                tone: 'text-dim' },
  service:      { title: 'Maintenance',                 tone: 'text-dim' },
}

// `paidThrough` is the day this room's money actually runs to. Without
// it the board called any guest past their original leaving date "Past
// due", whether they owed ₦156,200 or nothing at all — and three of the
// four rooms flagged at Awka on 16 October were fully paid. Past due now
// means the money ran out; a guest paid up to today is leaving today.
function stateOf(room, paidThrough) {
  if (room.out_of_service) return 'service'
  if (!room.stay_id) return 'vacant'
  if (room.is_overdue) {
    const through = paidThrough?.[room.stay_id]
    if (!through) return 'overdue'
    const today = lagosToday()
    return through < today ? 'overdue' : through === today ? 'leaving' : 'occupied'
  }
  if (room.status === 'reserved') {
    // The whole point of letting a future reservation not block the
    // room early is that staff still need a clear, unmissable signal
    // once its actual date arrives — this is that signal.
    //
    // Before that date the room is simply free, and must read that way.
    // Giving a November booking its own "Reserved" card hid six rooms
    // the desk could have let tonight.
    return room.check_in_date <= lagosToday() ? 'reserved_due' : 'vacant'
  }
  // Due out today reads the same whether the date was always today or
  // the money moved it there, so the desk sees one kind of room.
  if (room.scheduled_out === lagosToday()) return 'leaving'
  return 'occupied'
}

const shortDate = d => new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })

// Free to sell right now: nobody in it, or the only stay on it is a
// booking for a later date. The booking is still named on the card, with
// how long the room can be let for before it starts.
const freeNow = room => !room.stay_id
  || (room.status === 'reserved' && room.check_in_date > lagosToday())
const nightsFree = room => Math.max(0, Math.round(
  (new Date(room.check_in_date) - new Date(lagosToday())) / 864e5))

// A room free for seventeen nights and one free until tomorrow are not
// the same offer, and they read identically in one colour. Two nights or
// fewer is the one that can go wrong — a guest let in for three nights
// on a room someone else has booked for Sunday.
const freeTone = n => n <= 2 ? 'text-clay' : n <= 7 ? 'text-amber' : 'text-leaf'
const bookedTone = n => n <= 2 ? 'text-clay' : n <= 7 ? 'text-amber' : 'text-dim'

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
  const [allRooms, setAllRooms] = useState(null)

  // Every reservation not yet arrived, so a room that looks free (or is
  // occupied right now) still shows that someone has booked it later.
  const [reservations, setReservations] = useState([])
  // How far each occupied room's money reaches. Empty is safe: stateOf
  // falls back to the old calendar-only reading.
  const [paidThrough, setPaidThrough] = useState({})
  const [showBookings, setShowBookings] = useState(false)
  const [filter, setFilter] = useState(null)   // a STATE key, or null for all
  // The GM's office is not a room anyone lets. Hidden from everyone but
  // gm/admin, read from rooms.is_internal rather than a room number.
  const seesInternal = is(staff.role, SUPERVISOR)
  const [internalIds, setInternalIds] = useState([])
  const refresh = () => {
    loadOccupancy(staff.branch_id).then(setAllRooms).catch(() => setAllRooms([]))
    loadUpcomingReservations(staff.branch_id).then(setReservations).catch(() => setReservations([]))
    loadPaidThrough(staff.branch_id).then(setPaidThrough).catch(() => setPaidThrough({}))
    loadInternalRoomIds(staff.branch_id).then(setInternalIds).catch(() => setInternalIds([]))
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

  if (allRooms === null) return <p className="px-5 text-dim">Loading…</p>

  // Everything below works on the rooms this person is allowed to see.
  const rooms = seesInternal ? allRooms : allRooms.filter(r => !internalIds.includes(r.room_id))

  const tally = rooms.reduce((acc, r) => {
    const s = stateOf(r, paidThrough); acc[s] = (acc[s] || 0) + 1; return acc
  }, {})

  // A booking three weeks out is not a room anyone can walk into, and as
  // a full card it doubled the length of the board — eleven PSN rooms
  // held for November sat beside the eleven live rooms they are booked
  // for. They live in the strip below now; the live card still names the
  // booking underneath the guest. A reservation whose day has ARRIVED
  // stays in the grid, because that one needs doing something about.
  // Room order, always. Sorting by urgency was tried and taken out: the
  // desk reads this board as a map of the building — 101, 102, 103 on
  // the left corridor — and moving the cards around took that away.
  // What needs attention is carried by the coloured bar and the counts
  // at the top instead, which do not disturb the layout.
  const sorted = [...rooms].sort((a, b) =>
    String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
  const shown = filter ? sorted.filter(r => stateOf(r, paidThrough) === filter) : sorted
  // A reservation is not a debt. Its whole booking shows as due with
  // nothing paid because the guest has not arrived — eleven PSN rooms
  // held for November were adding ₦1,650,000 here, five times every real
  // balance together, so the outstanding figure meant nothing. Counted
  // separately below as what is booked, not as what is owed.
  const arrived = rooms.filter(r => r.status !== 'reserved')
  const owed = arrived.reduce((s, r) => s + Math.max(Number(r.outstanding || 0), 0), 0)
  const onDeposit = arrived.reduce((s, r) => s + Math.max(-Number(r.outstanding || 0), 0), 0)
  const booked = rooms.filter(r => r.status === 'reserved')
    .reduce((s, r) => s + Math.max(Number(r.outstanding || 0), 0), 0)

  return (
    <div className="px-5">
      {!!rooms.length && (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 py-3 border-b border-line mb-3">
          {/* Tap a count to see only those rooms. This is the triage the
              urgency sort used to give, without moving a single card:
              the rooms that stay are still in building order, the rest
              are just out of the way for a moment. */}
          {Object.entries(STATE).map(([key, s]) => {
            const n = tally[key] || 0
            const on = filter === key
            return (
              <button key={key} disabled={!n}
                onClick={() => setFilter(on ? null : key)}
                aria-pressed={on}
                className={`text-dim text-sm rounded-lg px-2 -mx-1 py-0.5 disabled:opacity-50
                  ${on ? 'bg-raise ring-1 ring-line' : ''}`}>
                <b className={`text-lg font-bold tnum ${s.text}`}>{n}</b> {s.label.toLowerCase()}
              </button>
            )
          })}
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
          {booked > 0 && (
            <span className="text-dim text-sm">
              <b className="text-lg font-bold tnum text-amber">{naira(booked)}</b> booked, not arrived
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
        const ahead = reservations.filter(r => r.checkIn > today)
        if (!due.length && !ahead.length) return null

        // Grouped by the day they arrive, because that is the question
        // being asked of this list: what is coming, and when.
        const byDay = []
        for (const r of ahead) {
          const last = byDay[byDay.length - 1]
          if (last && last.day === r.checkIn) last.rows.push(r)
          else byDay.push({ day: r.checkIn, rows: [r] })
        }
        const nights = r => Math.max(1, Math.round(
          (new Date(r.scheduledOut) - new Date(r.checkIn)) / 864e5))

        return (
          <div className="mb-4 space-y-3">
            {/* Today's arrivals still shout. A room someone is due in
                today is the one thing on this page that can be sold out
                from under a guest who has already booked it. */}
            {!!due.length && (
              <div className="rounded-2xl border-2 border-clay bg-clay/10 p-4 text-clay">
                <p className="font-bold">
                  {due.length} reservation{due.length === 1 ? '' : 's'} due — keep {due.length === 1 ? 'this room' : 'these rooms'} free
                </p>
                <div className="mt-2 space-y-1">
                  {due.map(r => (
                    <p key={r.stayId} className="text-sm">
                      <b>Room {r.roomNumber}</b> — {r.guest}
                      <span className="text-dim"> · {r.checkIn === today ? 'today' : 'since ' + shortDate(r.checkIn)}
                        {' → out '}{shortDate(r.scheduledOut)}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {!!ahead.length && (
              <div className="rounded-2xl border border-amber bg-amber/10 overflow-hidden">
                <button onClick={() => setShowBookings(b => !b)}
                  className="w-full flex items-center gap-3 p-4 text-left">
                  <span className="text-xl font-bold tnum text-amber">{ahead.length}</span>
                  <span className="min-w-0">
                    <span className="font-bold text-amber block">rooms booked ahead</span>
                    <span className="text-dim text-xs tnum">
                      {booked > 0 && `${naira(booked)} · `}first arrival {shortDate(ahead[0].checkIn)}
                    </span>
                  </span>
                  <span className="ml-auto text-dim text-sm shrink-0">{showBookings ? 'Hide' : 'Show'}</span>
                </button>
                {showBookings && (
                  <div className="px-4 pb-4">
                    {byDay.map(g => (
                      <div key={g.day} className="mt-2">
                        <p className="text-dim text-xs font-bold uppercase tracking-wide">
                          {shortDate(g.day)} — {g.rows.length} room{g.rows.length === 1 ? '' : 's'}
                        </p>
                        {g.rows.map(r => (
                          <p key={r.stayId} className="text-sm mt-0.5">
                            <b className="tnum">Room {r.roomNumber}</b> — {r.guest}
                            <span className="text-dim tnum"> · {nights(r)} night{nights(r) === 1 ? '' : 's'}</span>
                          </p>
                        ))}
                      </div>
                    ))}
                    <p className="text-dim text-xs mt-3">Do not sell these rooms for the dates shown.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {filter && (
        <button onClick={() => setFilter(null)}
          className="w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm mb-3">
          Showing {shown.length} of {rooms.length} rooms — show all
        </button>
      )}

      {ORDER.map(groupKey => {
        const group = shown.filter(r => stateOf(r, paidThrough) === groupKey)
        if (!group.length) return null
        const sec = SECTION[groupKey]
        return (
      <section key={groupKey} className="mb-5">
        <h2 className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2 ${sec.tone}`}>
          {sec.title}
          <span className="text-ink bg-raise rounded-full px-2 py-0.5 tnum font-bold">{group.length}</span>
        </h2>
        <div className="grid grid-cols-2 gap-3">
        {group.map(room => {
          const stateKey = stateOf(room, paidThrough)
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
                ) : (room.guest_name && !freeNow(room)) ? (
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
                    <p className="text-dim text-xs tnum mt-0.5">
                      out {new Date(room.scheduled_out + 'T12:00:00').toLocaleDateString('en-NG',
                        { day: 'numeric', month: 'short' })}
                      {room.remaining_nights != null && room.remaining_nights >= 0
                        && ` · ${room.remaining_nights}n left`}
                    </p>
                    {/* Where the date is behind the money, say so on the
                        card instead of leaving it looking overdue. The
                        folio offers to move it. */}
                    {stateKey !== 'overdue' && room.is_overdue && paidThrough[room.stay_id] && (
                      <p className="text-amber text-xs font-semibold mt-0.5 tnum">
                        paid to {shortDate(paidThrough[room.stay_id])}
                      </p>
                    )}
                    {stateKey === 'overdue' && paidThrough[room.stay_id] && (
                      <p className="text-clay text-xs font-semibold mt-0.5 tnum">
                        money ran out {shortDate(paidThrough[room.stay_id])}
                      </p>
                    )}
                    {/* One money line, always answering the same question.
                        It used to be three different things in one slot:
                        a booking's value, a deposit left, a debt. */}
                    {Number(room.outstanding) > 0.009 ? (
                      <p className="text-clay text-xs font-semibold mt-0.5">
                        Owes {naira(room.outstanding)}
                      </p>
                    ) : Number(room.outstanding) < -0.009 ? (
                      <p className="text-leaf text-xs font-semibold mt-0.5">
                        {naira(-room.outstanding)} paid ahead
                      </p>
                    ) : (
                      <p className="text-dim text-xs font-semibold mt-0.5">Settled</p>
                    )}
                    {room.bill_to && (
                      <p className="text-amber text-xs font-semibold mt-0.5 truncate">→ {room.bill_to}</p>
                    )}
                    <NextBooking room={room} reservations={reservations} />
                  </>
                ) : (
                  <>
                    <p className="text-dim text-sm mt-2">Ready to let</p>
                    {/* A room booked for a later date is free until then,
                        and "free for 17 nights" is the question actually
                        asked when someone walks up to the desk. */}
                    {room.status === 'reserved' && room.guest_name ? (
                      <>
                        <p className={`text-xs font-semibold mt-0.5 tnum ${freeTone(nightsFree(room))}`}>
                          Free for {nightsFree(room)} night{nightsFree(room) === 1 ? '' : 's'}
                          {nightsFree(room) <= 2 && ' only'}
                        </p>
                        <p className={`text-xs font-semibold mt-0.5 truncate ${bookedTone(nightsFree(room))}`}>
                          Booked: {room.guest_name} from {shortDate(room.check_in_date)}
                        </p>
                      </>
                    ) : (
                      <NextBooking room={room} reservations={reservations} />
                    )}
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
      </section>
        )
      })}

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
