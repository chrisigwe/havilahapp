import { useEffect, useState } from 'react'
import { loadUpcomingReservations } from '../lib/data'
import { lagosToday, addDays } from '../lib/format'

// Shown on every page (not just Rooms) to the people who sell rooms, so a
// booked-in-advance room is not sold by mistake. Covers anything due today,
// already overdue (reserved but never checked in), or arriving tomorrow.
// Tapping it opens the Rooms page, which has the full list.
export default function ReservationBanner({ branchId, tab, onTab }) {
  const [list, setList] = useState([])
  useEffect(() => {
    if (!branchId) return
    let live = true
    const go = () => loadUpcomingReservations(branchId, 1)
      .then(r => { if (live) setList(r) }).catch(() => { if (live) setList([]) })
    go()
    const t = setInterval(go, 5 * 60 * 1000)
    return () => { live = false; clearInterval(t) }
  }, [branchId, tab])

  // The Rooms page already shows these in detail.
  if (tab === 'roomboard' || !list.length) return null

  const today = lagosToday(), tomorrow = addDays(today, 1)
  const now = list.filter(r => r.checkIn <= today)
  const next = list.filter(r => r.checkIn === tomorrow)
  const parts = []
  if (now.length) parts.push(`${now.length} room${now.length === 1 ? '' : 's'} reserved for today: ${now.map(r => r.roomNumber).join(', ')}`)
  if (next.length) parts.push(`${next.length} for tomorrow: ${next.map(r => r.roomNumber).join(', ')}`)

  return (
    <button onClick={() => onTab('roomboard')}
      className={`w-full text-left px-5 py-3 border-b ${now.length ? 'bg-clay/15 border-clay' : 'bg-amber/15 border-amber'}`}>
      <p className={`font-bold ${now.length ? 'text-clay' : 'text-amber'}`}>Reserved rooms — do not sell</p>
      <p className="text-sm text-dim">{parts.join(' · ')} · tap to view</p>
    </button>
  )
}
