import { useEffect, useState } from 'react'
import { loadStaffOfMonth } from '../lib/data'

// Company-wide, not branch-scoped — shows the same winner to every
// branch and role. Fetches once per mount (the banner doesn't need to
// live-update mid-session); disappears entirely once posted_at is
// more than 7 days old, per the explicit "up for only a week" rule —
// the underlying row stays in the table as history, this just stops
// rendering it.
export default function StaffOfMonthBanner() {
  const [entry, setEntry] = useState(null)
  useEffect(() => {
    loadStaffOfMonth().then(setEntry).catch(() => setEntry(null))
  }, [])

  if (!entry || !entry.isActive) return null

  return (
    <div className="px-5 py-3 bg-amber/15 border-b border-amber flex items-center gap-3">
      {entry.photo_url ? (
        <img src={entry.photo_url} alt="" className="w-12 h-12 rounded-full object-cover border-2 border-amber shrink-0" />
      ) : (
        <div className="w-12 h-12 rounded-full bg-amber/30 flex items-center justify-center text-xl shrink-0">🏆</div>
      )}
      <div className="min-w-0">
        <p className="font-bold truncate">{entry.staff_name} — Staff of the Month</p>
        <p className="text-dim text-sm">Winner of the ₦10,000 grand prize — great job!</p>
      </div>
    </div>
  )
}
