import { useEffect, useState } from 'react'
import { naira, methodLabel } from '../lib/format'
import { loadCreditChain } from '../lib/data'
import { tracked } from '../lib/loadfail'

// '9 Oct'. Noon so no timezone can move it to the day before.
const shortDate = d => !d ? '' : new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })

// What was taken, when, and how it came back (Chris, 24 October 2026).
//
// Credit and Recovery each told half the story: one said what a person
// owes, the other said money arrived. Neither could say that the two
// Desperados from the 9th are settled and the Flying Fish from the 13th
// is not, because nothing records which sale a repayment paid off.
//
// credit_chain rebuilds it at read time by running repayments against
// that customer's credit sales oldest first — which is how they are
// applied in practice anyway. See 570 for why that is honest rather
// than a guess.
export default function CreditChain({ branchId, customerId, days = 120, className = '' }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [all, setAll] = useState(false)

  useEffect(() => {
    if (!branchId || !customerId) return
    setRows(null); setErr(null)
    tracked('What was taken and how it was recovered',
      loadCreditChain(branchId, customerId, days))
      .then(setRows)
      .catch(e => setErr(e.message || 'could not load'))
  }, [branchId, customerId, days])

  if (err) {
    return (
      <p className={`text-clay text-sm ${className}`}>
        The list of what was taken could not be loaded — this is not the same as
        nothing being taken.
      </p>
    )
  }
  if (rows === null) return <p className={`text-dim text-sm ${className}`}>Loading…</p>
  if (!rows.length) {
    return <p className={`text-dim text-sm ${className}`}>Nothing taken on credit in this period.</p>
  }

  const owed = rows.reduce((t, r) => t + Number(r.still_owed || 0), 0)
  const back = rows.reduce((t, r) => t + Number(r.recovered || 0), 0)
  const shown = all ? rows : rows.slice(0, 8)

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim text-sm">
          {rows.length} thing{rows.length === 1 ? '' : 's'} taken
        </span>
        <span className="text-sm shrink-0">
          <span className="tnum text-leaf font-semibold">{naira(back)}</span>
          <span className="text-dim"> back · </span>
          <span className={`tnum font-semibold ${owed > 0.009 ? 'text-clay' : 'text-leaf'}`}>
            {naira(owed)}
          </span>
          <span className="text-dim"> owing</span>
        </span>
      </div>

      <ul className="mt-2 divide-y divide-line/60">
        {shown.map(r => {
          const left = Number(r.still_owed || 0)
          const part = left > 0.009 && Number(r.recovered || 0) > 0.009
          return (
            <li key={r.sale_id} className="py-2.5">
              <div className="flex items-baseline gap-3">
                <span className="flex-1 min-w-0 font-semibold break-words">{r.item}</span>
                <span className="tnum font-semibold shrink-0">{naira(r.amount)}</span>
              </div>
              <div className="text-dim text-sm tnum">
                {r.qty ? `${r.qty} × ${naira(r.unit_price)} · ` : ''}
                taken {shortDate(r.taken_on)}
                {r.dept ? ` · ${r.dept}` : ''}
              </div>
              {/* The answer to the question both pages were missing. */}
              {left <= 0.009 ? (
                <div className="text-leaf text-sm font-semibold">
                  {/* No date means no repayment on or after the day it was
                      taken cleared it — they were already in credit. Saying
                      that beats printing a date that cannot be true (573). */}
                  {r.cleared_on
                    ? <>Recovered {shortDate(r.cleared_on)}
                        {r.cleared_by ? ` · ${methodLabel[r.cleared_by] || r.cleared_by}` : ''}</>
                    : 'Covered — they were already in credit'}
                </div>
              ) : (
                <div className="text-clay text-sm font-semibold tnum">
                  {part ? `${naira(r.recovered)} back · ${naira(left)} still owing` : `${naira(left)} still owing`}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {rows.length > shown.length && (
        <button onClick={() => setAll(true)}
          className="mt-2 h-10 w-full rounded-xl border border-line text-dim text-sm font-semibold">
          Show all {rows.length}
        </button>
      )}

      <p className="text-dim text-xs mt-2">
        Money paid is applied to the oldest thing still owing first, which is how
        it is settled at the till. A payment is not tied to one particular item.
      </p>
    </div>
  )
}
