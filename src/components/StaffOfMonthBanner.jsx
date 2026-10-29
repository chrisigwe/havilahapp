import { useEffect, useState } from 'react'
import { loadStaffOfMonth } from '../lib/data'
import { naira } from '../lib/format'
import { tracked } from '../lib/loadfail'

// Per branch — shows THIS branch's own winner, not a shared one.
// Fetches once per mount for the current branch (the banner doesn't
// need to live-update mid-session, and re-fetches naturally on a
// branch switch since Shell re-renders with a new branchId then);
// disappears once the post is older than SOM_DAYS (three, from 29
// October 2026 — it was a week) counted from the day it went up and
// from nothing else. The underlying row stays in the table as history;
// this just stops rendering it.
export default function StaffOfMonthBanner({ branchId }) {
  const [entry, setEntry] = useState(null)
  useEffect(() => {
    if (!branchId) return
    tracked('Staff of the month', loadStaffOfMonth(branchId)).then(setEntry).catch(() => setEntry(null))
  }, [branchId])

  if (!entry || !entry.isActive) return null

  return (
    // Compact, not removed (Chris, 27 October 2026). It is pinned under
    // the bar now, so it costs that height on every screen all day —
    // half the padding and a smaller photo keeps the celebration and
    // gives the page back about 20px.
    <div className="px-5 py-2 bg-amber/15 border-b border-amber flex items-center gap-3">
      {entry.photo_url ? (
        // Rendered as a CSS background rather than an <img> on purpose.
        // Long-press "Save image" / "Share" on iOS and Android targets
        // image ELEMENTS; a div with a background has nothing for that
        // menu to act on. The callout/select/drag properties below
        // close the remaining routes (iOS callout, desktop right-click
        // and drag-to-desktop).
        <div
          role="img"
          aria-label={`${entry.staff_name}, Staff of the Month`}
          onContextMenu={e => e.preventDefault()}
          draggable={false}
          style={{
            backgroundImage: `url("${entry.photo_url}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
          className="w-9 h-9 rounded-full border-2 border-amber shrink-0"
        />
      ) : (
        <div className="w-9 h-9 rounded-full bg-amber/30 flex items-center justify-center shrink-0">🏆</div>
      )}
      {/* One line. The two lines said the same thing twice — the name,
          the title, then the title again as a sentence. */}
      <div className="min-w-0">
        <p className="font-semibold truncate text-sm">
          {entry.staff_name} — Staff of the Month
        </p>
        <p className="text-dim text-xs truncate">{naira(entry.prize_amount)} prize</p>
      </div>
    </div>
  )
}
