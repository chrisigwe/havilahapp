import { useEffect, useState } from 'react'
import { refusedJobs, onRefusedChange, dismissRefused, retryRefused, flush } from '../lib/outbox'
import { describeJob, refusalReason } from '../lib/outboxtext'

// ENTRIES THE SERVER TURNED DOWN (Chris, 23 November 2026).
//
// Until now these were dropped inside the outbox with a line in the
// console. The person who made the entry had already been told "saved,
// will send when you are back online", so from their side the sale
// existed; it simply never arrived, and nothing anywhere said so.
//
// This card is the whole of the fix: it shows what was refused, in the
// server's own words, and will not go away until somebody says they
// have dealt with it. Deliberately not a toast -- a toast is gone in
// four seconds and this may be money.
export default function RefusedWrites() {
  const [jobs, setJobs] = useState(refusedJobs)
  useEffect(() => onRefusedChange(() => setJobs(refusedJobs())), [])
  if (!jobs.length) return null

  const when = (t) => {
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-NG', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <section className="mx-4 mb-4 rounded-2xl border border-clay bg-surface overflow-hidden">
      <div className="px-4 py-3 bg-clay/15">
        <p className="font-extrabold text-clay">
          {jobs.length === 1 ? 'One entry was not accepted' : `${jobs.length} entries were not accepted`}
        </p>
        <p className="text-dim text-xs mt-0.5">
          {jobs.length === 1 ? 'It was' : 'They were'} saved on this phone and sent later, and the
          server turned {jobs.length === 1 ? 'it' : 'them'} down. Nothing has been recorded.
        </p>
      </div>
      <ul className="divide-y divide-line/60">
        {jobs.map(j => (
          <li key={j.id} className="px-4 py-3">
            <p className="font-semibold text-sm">{describeJob(j)}</p>
            <p className="text-clay text-xs mt-0.5">{refusalReason(j.reason)}</p>
            <p className="text-dim text-xs mt-0.5">Tried {when(j.refused_at)}</p>
            <div className="flex gap-3 mt-2">
              <button onClick={() => { retryRefused(j.id); flush() }}
                className="h-9 px-3 rounded-lg bg-amber text-bg text-sm font-bold">Try again</button>
              <button onClick={() => dismissRefused(j.id)}
                className="h-9 px-3 rounded-lg border border-line text-dim text-sm">
                I have entered it again
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
