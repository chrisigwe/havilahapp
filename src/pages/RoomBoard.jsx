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
import Notice from '../components/Notice'
import { tracked } from '../lib/loadfail'

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

// Which row wins when a room has more than one stay against it — the
// nearest to happening. A guest in the bed beats a booking for November.
const LIVENESS = {
  service: 0, overdue: 1, reserved_due: 2, leaving: 3, occupied: 4, vacant: 5,
}

// One serial run, 101 through the Suite, and no section headings.
//
// Three orderings were tried on the desk. Grouping without headings read
// as shuffled. Grouping with headings cut the corridor into four pieces.
// Labelling a serial run put a heading every other pair, because status
// is not something rooms are sorted into — it changes as you walk down
// the hall. What stayed is the plain run, with the coloured bar on each
// card and the counts at the top, which filter without moving anything.

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
    tracked('Guests who left still owing', loadCheckoutsStillOwing(staff.branch_id)).then(setOwingCheckouts).catch(() => setOwingCheckouts([]))
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
    tracked('The room board', loadOccupancy(staff.branch_id)).then(setAllRooms).catch(() => setAllRooms([]))
    tracked('Bookings not yet arrived', loadUpcomingReservations(staff.branch_id)).then(setReservations).catch(() => setReservations([]))
    tracked('How far each room is paid', loadPaidThrough(staff.branch_id)).then(setPaidThrough).catch(() => setPaidThrough({}))
    tracked('Which rooms are internal', loadInternalRoomIds(staff.branch_id)).then(setInternalIds).catch(() => setInternalIds([]))
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
  const visible = seesInternal ? allRooms : allRooms.filter(r => !internalIds.includes(r.room_id))

  // ONE CARD PER ROOM.
  //
  // The occupancy view returns a row per STAY, so a room with a guest in
  // it and a booking for November came back twice and was drawn twice.
  // That was merely untidy while a booking rendered as "Reserved"; once
  // a future booking started reading as "Ready to let" it became a lie —
  // room 202 would have shown Mr Okoye asleep in it beside a card
  // offering it to the next walk-in.
  //
  // So each room keeps its most live row. The future booking is not
  // lost: the card names it underneath the guest, which is where the
  // desk was already reading it.
  const byRoom = new Map()
  for (const r of visible) {
    const rank = LIVENESS[stateOf(r, paidThrough)] ?? 9
    const held = byRoom.get(r.room_id)
    if (!held || rank < held.rank) byRoom.set(r.room_id, { row: r, rank })
  }
  const rooms = [...byRoom.values()].map(h => h.row)

  // TWO GUESTS IN ONE ROOM (20 October 2026).
  //
  // Keeping the most live row per room is right for a booking sitting
  // behind a guest. It is wrong when two rows are both 'occupied': the
  // ranks tie, one is kept arbitrarily, and the other disappears from
  // the board with nothing said.
  //
  // That is how Room 103 at Awka carried Mr Factor — checked in on the
  // 18th, due out on the 19th, never checked out — while Pst Pascal was
  // checked into the same room on the 19th. The desk could not see it,
  // because the board showed one card and one name. His bill sat open
  // on a bed somebody else was sleeping in.
  //
  // A reopened checkout does the same thing: while it is being
  // corrected its status reads 'occupied', so it competes with whoever
  // is in the room now.
  const liveByRoom = new Map()
  for (const r of visible) {
    if (r.status !== 'occupied') continue
    liveByRoom.set(r.room_id, [...(liveByRoom.get(r.room_id) || []), r])
  }
  const doubled = [...liveByRoom.values()].filter(list => list.length > 1)

  // EVERY BOOKING ON A ROOM MUST BE REACHABLE (28 October 2026).
  //
  // byRoom keeps ONE row per room. That is right for a booking sitting
  // behind a guest, but when a room carries two FUTURE bookings both
  // rank the same, the tie is broken by whichever row the view returned
  // first, and the loser vanishes — card, name and folio with it.
  //
  // Eleven surveyors were booked into Awka for 29 October. Ten of those
  // rooms already held a PSN booking for 2 November, so ten folios could
  // not be opened to take the deposit, and which one you could reach was
  // luck. Room 207, the only one booked once, worked fine.
  //
  // So every reservation on a room is listed on its card, soonest first,
  // each one opening its own folio.
  const bookingsByRoom = new Map()
  for (const r of visible) {
    if (r.status !== 'reserved' || !r.stay_id) continue
    bookingsByRoom.set(r.room_id, [...(bookingsByRoom.get(r.room_id) || []), r])
  }
  for (const list of bookingsByRoom.values()) {
    list.sort((a, b) => String(a.check_in_date).localeCompare(String(b.check_in_date)))
  }

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
  const booked = visible.filter(r => r.status === 'reserved')
    .reduce((s, r) => s + Math.max(Number(r.outstanding || 0), 0), 0)

  return (
    <div className="px-5">
      {!!rooms.length && (() => {
        // How full the house is, which is the first thing anyone asks of
        // a room board and the one figure it never showed (19 October
        // 2026). Occupied means a guest is in the bed tonight: every
        // state except vacant and maintenance.
        const beds = rooms.length
        const free = tally.vacant || 0
        const oos = tally.service || 0
        const taken = beds - free - oos
        const pct = beds - oos > 0 ? Math.round((taken / (beds - oos)) * 100) : 0
        return (
          <>
            <section className="rounded-2xl border border-line bg-surface p-4 mt-3">
              <div className="text-dim text-sm">Rooms taken tonight</div>
              <div className="flex items-baseline gap-2">
                <span className="tnum text-3xl font-bold text-amber">{taken}</span>
                <span className="text-dim">of {beds - oos}</span>
                <span className="tnum text-dim ml-auto">{pct}%</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-raise overflow-hidden">
                <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-dim text-sm mt-1">
                {free} free{oos > 0 && <> · {oos} out of service</>}
              </div>

              {/* The money, separated from the room counts by a rule.
                  These three were mixed into the same wrapping row as
                  the status tallies, where a naira figure and a count of
                  rooms sat side by side reading as the same kind of
                  thing.

                  Rows, not columns: three figures side by side cut
                  ₦1,650,000 down to "₦1,650,0…" at 320px, and a
                  truncated naira figure is worse than no figure. */}
              {(owed > 0 || onDeposit > 0 || booked > 0) && (
                <div className="mt-3 pt-3 border-t border-line space-y-1 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-dim min-w-0">Outstanding</span>
                    <span className="tnum font-bold text-clay shrink-0">{naira(owed)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-dim min-w-0">On deposit</span>
                    <span className="tnum font-bold text-leaf shrink-0">{naira(onDeposit)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-dim min-w-0">Booked, not arrived</span>
                    <span className="tnum font-bold text-amber shrink-0">{naira(booked)}</span>
                  </div>
                </div>
              )}
            </section>

            {/* Tap a count to see only those rooms. This is the triage the
                urgency sort used to give, without moving a single card:
                the rooms that stay are still in building order, the rest
                are just out of the way for a moment.

                Proper chips now, each its own tap target. They were text
                runs sharing one wrapping line, and on a phone the edge of
                one sat against the start of the next. */}
            <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1 mb-1">
              {Object.entries(STATE).map(([key, st]) => {
                const n = tally[key] || 0
                const on = filter === key
                if (!n) return null
                return (
                  <button key={key}
                    onClick={() => setFilter(on ? null : key)}
                    aria-pressed={on}
                    className={`shrink-0 h-11 px-4 rounded-full border text-sm inline-flex items-center gap-1.5 ${
                      on ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                    {/* items-center, not items-baseline: baseline
                        alignment of a bold number against a smaller
                        label left both sitting high in a 44px pill
                        instead of centred in it.

                        And the chosen chip is solid amber, the same as
                        every other chip row in the app. It used to be a
                        raised background with an amber edge, which on a
                        dark screen is almost the same as not chosen. */}
                    <b className={`text-base font-bold tnum ${on ? 'text-bg' : st.text}`}>{n}</b>
                    <span>{st.label.toLowerCase()}</span>
                  </button>
                )
              })}
            </div>
          </>
        )
      })()}

      {!!doubled.length && (
        <Notice tone="problem" className="mb-4"
          title={`${doubled.length} room${doubled.length === 1 ? '' : 's'} with two guests checked in`}>
          <p className="mb-2">
            Two stays are open on the same room. One of them is almost certainly a
            guest who was never checked out — their bill is still running on a bed
            somebody else is in, and only one of the two shows on the board below.
          </p>
          {doubled.map(list => (
            <div key={list[0].room_id} className="py-1 border-t border-line/40 first:border-0">
              <span className="font-semibold">Room {list[0].room_number}</span>
              {list.map(r => (
                <span key={r.stay_id} className="block text-xs">
                  {r.guest_name || 'Guest'} · in {r.check_in_date} · due {r.scheduled_out}
                </span>
              ))}
            </div>
          ))}
          <p className="mt-2 text-xs">
            Check the one who has left out of their room, on the day they actually left.
          </p>
        </Notice>
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
        <Notice tone="problem" className="mb-4"
          title={`${owingCheckouts.length} guest${owingCheckouts.length === 1 ? '' : 's'} checked out still owing`}>
          <div className="space-y-2">
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
        </Notice>
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

      <div className="grid grid-cols-2 gap-3">
        {shown.map(room => {
          const stateKey = stateOf(room, paidThrough)
          const s = STATE[stateKey]
          const books = bookingsByRoom.get(room.room_id) || []
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
                      /* Full width and wrapping (21 October 2026). A
                         fixed-height button with a seven-word label ran
                         straight out of the card: these sit two to a
                         row, so there are about 100px to play with and
                         the text cannot be allowed to set the width.
                         "Guest arrived — check in now" wrapped to four
                         lines and made the card twice the height of its
                         neighbour; "Arrived" keeps the precondition —
                         do not check a guest in before they turn up —
                         in two. */
                      <button onClick={(e) => { e.stopPropagation(); checkInNow(room) }} disabled={oosBusy}
                        className="mt-2 w-full min-h-9 px-2 py-1.5 rounded-lg bg-amber text-bg
                                   text-xs font-bold leading-tight text-center disabled:opacity-40">
                        Arrived — check in
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
                    {books.length ? (
                      <>
                        <p className={`text-xs font-semibold mt-0.5 tnum ${freeTone(nightsFree(books[0]))}`}>
                          Free for {nightsFree(books[0])} night{nightsFree(books[0]) === 1 ? '' : 's'}
                          {nightsFree(books[0]) <= 2 && ' only'}
                        </p>
                        {books.map(b => (
                          <button key={b.stay_id} type="button"
                            onClick={(e) => { e.stopPropagation(); setOpenStay(b) }}
                            className="mt-1 block w-full text-left active:opacity-70">
                            <span className={`block text-xs font-semibold truncate ${bookedTone(nightsFree(b))}`}>
                              Booked: {b.guest_name} from {shortDate(b.check_in_date)}
                            </span>
                            <span className="block text-xs tnum text-dim">
                              {Number(b.outstanding) > 0.009
                                ? `${naira(b.outstanding)} due · tap to take payment`
                                : 'Paid · tap to open'}
                            </span>
                          </button>
                        ))}
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
