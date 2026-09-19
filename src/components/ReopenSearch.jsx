import { useEffect, useState } from 'react'
import { searchRecentCheckouts } from '../lib/data'

// Finds a stay checked out in the last two weeks, since checked-out
// stays don't appear in v_occupancy_today (the room just reverts to
// vacant there) — this is the entry point that was missing when
// Folio's own reopen section was built but had nowhere to be reached
// from.
export default function ReopenSearch({ boot, onPick, onClose }) {
  const { staff } = boot
  const [q, setQ] = useState('')
  const [rows, setRows] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => {
      searchRecentCheckouts(staff.branch_id, q).then(setRows).catch(() => setRows([]))
    }, 200)
    return () => clearTimeout(t)
  }, [q, staff.branch_id])

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col">
      <div className="p-5">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">Recently checked out</h2>
        <p className="text-dim mt-1">Last two weeks. Find by room number or guest name.</p>
        <input value={q} onChange={e => setQ(e.target.value)} autoFocus
          placeholder="Room number or guest name"
          className="mt-4 w-full h-14 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        <ul className="divide-y divide-line/60">
          {(rows || []).map(s => (
            <li key={s.id}>
              <button
                onClick={() => onPick({
                  stay_id: s.id, room_number: s.rooms?.room_number, guest_name: s.guests?.full_name,
                  status: 'checked_out', check_in_date: s.check_in_date,
                  scheduled_out: s.scheduled_out, actual_out: s.actual_out,
                })}
                className="w-full text-left py-3">
                <div className="flex items-center gap-3">
                  <span className="font-bold w-14">{s.rooms?.room_number}</span>
                  <span className="flex-1 min-w-0 truncate">{s.guests?.full_name}</span>
                  <span className="text-dim text-sm tnum">{s.actual_out}</span>
                </div>
              </button>
            </li>
          ))}
          {rows !== null && !rows.length && (
            <li className="py-8 text-center text-dim">
              {q ? `No match for "${q}".` : 'No checkouts in the last two weeks.'}
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
