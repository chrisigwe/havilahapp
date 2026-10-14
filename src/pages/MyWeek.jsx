import { useEffect, useState } from 'react'
import { loadMyWeek } from '../lib/data'
import { OVERSIGHT, is } from '../lib/roles'

// "My week" — how steadily a person is doing the Total Sales check.
//
// It counts the check being DONE, never the figures agreeing. That is
// deliberate and worth stating here so nobody changes it by accident: a
// streak that needs a match is a streak that pays people to make the
// numbers agree, and the one thing a close-of-day check must never do is
// reward a tidy figure over an honest one. A day where the drawer came up
// short, declared and saved, is a good day on this page.
//
// A day with no sales is simply skipped. Nobody loses a streak for a day
// off, which is why the dots show only days the person actually sold.

const dayLabel = d => new Date(d + 'T12:00:00')
  .toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric' })

function Dots({ week }) {
  if (!week?.length) return <p className="text-dim text-sm">No selling days yet.</p>
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {week.map(d => (
        <div key={d.date} className="text-center">
          <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-bold ${
            d.checked ? 'bg-leaf border-leaf text-bg' : 'border-clay text-clay'}`}>
            {d.checked ? '✓' : '·'}
          </div>
          <div className="text-dim text-[10px] mt-0.5">{dayLabel(d.date)}</div>
        </div>
      ))}
    </div>
  )
}

function Badge({ badge }) {
  if (!badge) return null
  return (
    <span className="ml-2 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">
      {badge} streak
    </span>
  )
}

export default function MyWeek({ boot }) {
  const { staff } = boot
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    setData(null); setErr(null)
    loadMyWeek(staff.branch_id, 7)
      .then(setData)
      .catch(e => { setErr(e.message || 'could not load'); setData({ me: [], team: [] }) })
  }, [staff.branch_id])

  if (!data) return <p className="px-5 text-dim py-6">Loading…</p>

  const me = data.me || []
  const team = data.team || []
  const oversight = is(staff.role, OVERSIGHT)

  return (
    <div className="px-5 pb-10">
      <div className="py-3 border-b border-line mb-3">
        <h1 className="text-2xl font-bold">My week</h1>
        <p className="text-dim text-sm mt-1">
          Doing the Total Sales check at close. A day counts whether the figures
          agreed or not — what matters is that the count was done and saved.
        </p>
      </div>

      {err && <p className="text-clay py-3">{err}</p>}

      {/* Said plainly, because a count of days someone "missed" is only
          fair if it starts when the check first existed. */}
      {data.since && (
        <p className="text-dim text-xs mb-3">
          Counting from {new Date(data.since + 'T12:00:00').toLocaleDateString('en-NG',
            { day: 'numeric', month: 'long' })}, when the Total Sales check was
          first used here. Days before that are nobody's miss.
        </p>
      )}

      {!me.length && !oversight && (
        <p className="text-dim py-8 text-center">
          Nothing yet. Your days appear here once you record sales and save your
          count at close.
        </p>
      )}

      {me.map(r => (
        <section key={r.counter} className="mb-4 rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <p className="font-bold text-lg">{r.counter}<Badge badge={r.badge} /></p>
            <span className={`tnum font-bold ${r.streak > 0 ? 'text-leaf' : 'text-dim'}`}>
              {r.streak} day{r.streak === 1 ? '' : 's'}
            </span>
          </div>
          <p className="text-dim text-sm">
            {r.checked_days} of {r.sold_days} selling days checked this week
            {r.streak > 0 ? ' · current streak' : ' · no streak running'}
          </p>
          <Dots week={r.week} />
          {r.streak === 0 && (
            <p className="text-amber text-sm mt-3">
              Save your count at close tonight and the streak starts tomorrow.
            </p>
          )}
          {r.badge && (
            <p className="text-leaf text-sm mt-3">
              {r.badge} without missing one. That is the whole job done properly.
            </p>
          )}
        </section>
      ))}

      {oversight && (
        <>
          <h2 className="text-dim mt-6 mb-2">Everyone</h2>
          {!team.length && <p className="text-dim text-sm py-4">No selling days recorded yet.</p>}
          <ul className="divide-y divide-line/60">
            {team.map((r, i) => (
              <li key={`${r.staff}-${r.counter}-${i}`} className="py-3 flex items-baseline gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">
                    {r.staff}<span className="text-dim font-normal"> · {r.counter}</span>
                    <Badge badge={r.badge} />
                  </p>
                  <p className="text-dim text-sm">
                    {r.checked_days} of {r.sold_days} this week · {r.checked_90} of {r.sold_90} since checks began
                  </p>
                </div>
                <span className={`tnum font-bold shrink-0 ${
                  r.streak >= 7 ? 'text-leaf' : r.streak > 0 ? 'text-amber' : 'text-clay'}`}>
                  {r.streak}d
                </span>
              </li>
            ))}
          </ul>
          <p className="text-dim text-xs mt-4">
            A streak counts the check being done, not the figures matching.
            Someone who declares a shortfall keeps their streak — and should.
          </p>
        </>
      )}
    </div>
  )
}
