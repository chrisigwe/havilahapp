import { useEffect, useState } from 'react'
import { loadCorrectionsOnDate } from '../lib/data'
import { lagosTime } from '../lib/format'

// What was undone to this day, after the fact.
//
// The day's close shows what was sold. It has never shown what was
// DELETED or EDITED afterwards, and that gap cost real time: an Amstel
// was counted at 1, a charge against it was later deleted, the bottle
// returned to the shelf, and nothing anywhere said so — it took reading
// the audit table to find. A figure and the corrections made to it
// belong on the same screen.
//
// Deliberately plain. A deletion is nearly always a typo being fixed,
// and this is a record, not an allegation. The entries that deserve a
// question are picked out on Needs a look; this is simply the day,
// honestly described.

const ACTION = { deleted: 'Deleted', edited: 'Edited' }

export default function CorrectionsOnDay({ branchId, date, locationId = null }) {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!branchId || !date) return
    setRows(null)
    loadCorrectionsOnDate(branchId, date, locationId).then(setRows).catch(() => setRows([]))
  }, [branchId, date, locationId])

  if (!rows?.length) return null

  const deleted = rows.filter(r => r.action === 'deleted').length

  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-bold">Changed after the fact</p>
          <p className="text-dim text-sm">
            {rows.length} {rows.length === 1 ? 'entry' : 'entries'} for this day
            {deleted > 0 && `, ${deleted} deleted`}
          </p>
        </div>
        <span className="text-dim">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4">
          <p className="text-dim text-sm mb-3">
            Entries belonging to this day that were changed or removed later.
            A deleted sale puts its stock back on the shelf, so a count taken
            before the deletion will not match one taken after.
          </p>
          <ul className="divide-y divide-line/60">
            {rows.map(r => (
              <li key={r.id} className="py-2">
                <div className="flex items-baseline gap-3">
                  <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded-full border ${
                    r.action === 'deleted' ? 'border-clay text-clay' : 'border-amber text-amber'}`}>
                    {ACTION[r.action] || r.action}
                  </span>
                  <span className="flex-1 min-w-0 text-sm">{r.summary}</span>
                </div>
                <p className="text-dim text-xs tnum mt-0.5">
                  {r.done_by_name || 'Admin'}
                  {r.happened_at ? ` · ${new Date(r.happened_at).toLocaleDateString('en-NG',
                    { day: 'numeric', month: 'short' })} ${lagosTime(r.happened_at)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
