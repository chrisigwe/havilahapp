import { useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { loadTillChecks } from '../lib/data'
import { useToast } from '../components/Toast'

const day = d => new Date(d + 'T12:00:00').toLocaleDateString('en-NG',
  { weekday: 'short', day: 'numeric', month: 'short' })

export default function TillChecks({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [data, setData] = useState(null)

  useEffect(() => {
    loadTillChecks(staff.branch_id, 14).then(setData).catch(e => toast(e.message, 'error'))
  }, [staff.branch_id])

  if (!data) return <p className="px-5 text-dim">Loading…</p>
  const { checks, missing } = data
  const clean = checks.filter(c => Math.abs(c.pos_gap) < 1 && Math.abs(c.cash_gap) < 1).length
  // Saved once, then saved again with a different number. Not wrong in
  // itself -- fixing a mis-keyed sale and re-checking is what the screen
  // is for -- but it is the one thing the old table could not tell you.
  const recounted = checks.filter(c => c.recounted).length

  const dates = [...new Set([...checks, ...missing].map(r => r.business_date))].sort().reverse()

  return (
    <div className="px-5 pb-8">
      <p className="text-dim text-sm py-2">
        What staff typed from the POS slip and the cash at hand when they matched their Total Sales. Last 14 days.
        {recounted > 0 && (
          <> <span className="text-amber">{recounted} {recounted === 1 ? 'check was' : 'checks were'} saved
          again with a different figure.</span></>
        )}
      </p>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-surface border border-line p-3">
          <div className="tnum text-2xl font-bold">{checks.length}</div>
          <div className="text-dim text-xs">checks done</div>
        </div>
        <div className="rounded-xl bg-surface border border-line p-3">
          <div className="tnum text-2xl font-bold text-leaf">{clean}</div>
          <div className="text-dim text-xs">matched</div>
        </div>
        <div className="rounded-xl bg-surface border border-line p-3">
          <div className={`tnum text-2xl font-bold ${missing.length ? 'text-clay' : ''}`}>{missing.length}</div>
          <div className="text-dim text-xs">sold, no check</div>
        </div>
      </div>

      {!dates.length && <p className="py-8 text-center text-dim">No checks yet.</p>}

      {dates.map(d => (
        <section key={d} className="mt-5">
          <h2 className="text-dim mb-1">{day(d)}</h2>
          <ul className="divide-y divide-line/60">
            {checks.filter(c => c.business_date === d).map((c, i) => {
              const ok = Math.abs(c.pos_gap) < 1 && Math.abs(c.cash_gap) < 1
              return (
                <li key={'c' + i} className="py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{c.staff} <span className="text-dim font-normal">· {c.location}</span></span>
                    <span className={ok ? 'text-leaf font-bold' : 'text-clay font-bold'}>{ok ? 'Matched ✓' : 'Gap'}</span>
                  </div>
                  {!ok && (
                    <div className="text-sm text-dim tnum mt-1">
                      {Math.abs(c.pos_gap) >= 1 && <div>POS: app is {naira(Math.abs(c.pos_gap))} {c.pos_gap > 0 ? 'more' : 'less'} than the terminal</div>}
                      {Math.abs(c.cash_gap) >= 1 && <div>Cash: {naira(Math.abs(c.cash_gap))} {c.cash_gap > 0 ? 'more' : 'less'} in hand than the app expects</div>}
                    </div>
                  )}
                  {/* A re-save used to overwrite the count with no trace,
                      and the app's figure is on screen by then -- so a
                      second attempt is not blind. The first figure is now
                      kept (26 November 2026) and said plainly here.
                      Three states on purpose: changed, unchanged, and
                      not known. A row from before the column existed must
                      not read as "the same figure each time", because
                      nobody knows that. */}
                  {c.attempts > 1 && (
                    c.recounted ? (
                      <div className="text-amber text-xs mt-1 tnum">
                        First counted{' '}
                        {Math.abs(Number(c.first_pos) - Number(c.counted_pos)) > 0.5
                          && `${naira(c.first_pos)} POS`}
                        {Math.abs(Number(c.first_pos) - Number(c.counted_pos)) > 0.5
                          && Math.abs(Number(c.first_cash) - Number(c.counted_cash)) > 0.5 && ' and '}
                        {Math.abs(Number(c.first_cash) - Number(c.counted_cash)) > 0.5
                          && `${naira(c.first_cash)} cash`}
                        , recorded{' '}
                        {Math.abs(Number(c.first_pos) - Number(c.counted_pos)) > 0.5
                          && `${naira(c.counted_pos)} POS`}
                        {Math.abs(Number(c.first_pos) - Number(c.counted_pos)) > 0.5
                          && Math.abs(Number(c.first_cash) - Number(c.counted_cash)) > 0.5 && ' and '}
                        {Math.abs(Number(c.first_cash) - Number(c.counted_cash)) > 0.5
                          && `${naira(c.counted_cash)} cash`}
                        {' '}· {c.attempts} attempts
                      </div>
                    ) : c.first_pos == null ? (
                      <div className="text-dim text-xs mt-1">
                        Checked {c.attempts} times — the first figures were not kept
                      </div>
                    ) : (
                      <div className="text-dim text-xs mt-1">
                        Checked {c.attempts} times, the same figures each time
                      </div>
                    )
                  )}
                </li>
              )
            })}
            {missing.filter(m => m.business_date === d).map((m, i) => (
              <li key={'m' + i} className="py-3 flex items-baseline justify-between gap-2">
                <span className="font-semibold">{m.staff} <span className="text-dim font-normal">· {m.location}</span></span>
                <span className="text-clay text-sm font-semibold">Sold, no check</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
