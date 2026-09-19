import { useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { loadOccupancy } from '../lib/data'
import CheckIn from './CheckIn'

// Phase 2 of bringing the front-desk app's functionality into this
// one: check-in and new bookings, alongside the view-only room status
// from phase 1. Folio, checkout, and settling a stay's bill are still
// in the separate front-desk app for now.
const STATE = {
  vacant:   { label: 'Vacant',      bar: 'bg-line',  text: 'text-dim' },
  occupied: { label: 'Occupied',    bar: 'bg-leaf',  text: 'text-leaf' },
  reserved: { label: 'Reserved',    bar: 'bg-amber', text: 'text-amber' },
  overdue:  { label: 'Past due',    bar: 'bg-clay',  text: 'text-clay' },
  service:  { label: 'Maintenance', bar: 'bg-dim',   text: 'text-dim' },
}

function stateOf(room) {
  if (room.out_of_service) return 'service'
  if (!room.stay_id) return 'vacant'
  if (room.is_overdue) return 'overdue'
  return room.status === 'reserved' ? 'reserved' : 'occupied'
}

export default function RoomBoard({ boot }) {
  const { staff } = boot
  const [checkingIn, setCheckingIn] = useState(false)
  const [rooms, setRooms] = useState(null)

  const refresh = () => { loadOccupancy(staff.branch_id).then(setRooms).catch(() => setRooms([])) }
  useEffect(refresh, [staff.branch_id])

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

      <button onClick={() => setCheckingIn(true)}
        className="w-full h-14 rounded-2xl border-2 border-amber text-amber text-lg font-bold mb-4">
        + New booking
      </button>

      {!rooms.length && <p className="py-8 text-center text-dim">No rooms set up for this branch yet.</p>}

      <div className="grid grid-cols-2 gap-3">
        {rooms.map(room => {
          const s = STATE[stateOf(room)]
          return (
            <div key={room.room_id} className="rounded-2xl border border-line bg-surface overflow-hidden flex">
              <div className={`w-1.5 shrink-0 ${s.bar}`} />
              <div className="px-3 py-3 min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xl font-bold tnum">{room.room_number}</span>
                  <span className={`text-xs font-semibold ${s.text}`}>{s.label}</span>
                </div>
                <p className="text-dim text-xs mt-0.5 truncate">{room.category}</p>

                {room.out_of_service ? (
                  <p className="text-dim text-sm mt-2 truncate">{room.oos_reason || 'Out of service'}</p>
                ) : room.guest_name ? (
                  <>
                    <p className="text-sm font-semibold mt-2 truncate">{room.guest_name}</p>
                    <p className="text-dim text-xs tnum mt-0.5">
                      out {new Date(room.scheduled_out).toLocaleDateString('en-NG',
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
                  </>
                ) : (
                  <p className="text-dim text-sm mt-2">Ready to let</p>
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
    </div>
  )
}
