import { naira } from '../lib/format'

// PR and damage for a day, itemised and kept apart.
//
// Was copied inline in SalesEntry only, while DAILY SALES kept its own
// older totals-only block ("Damaged 6 units · ₦22,000") — so fixing one
// left the other unchanged, which is exactly what happened. One
// component now, used by both, as with ReceptionDashboard.
//
// PR is a decision someone made; damage is a loss that needs checking
// against the breakages. Each line names the item, quantity, cost,
// reason and who recorded it.
export default function WriteoffBreakdown({ data, settled }) {
  if (!data && !settled) return null
  const byPayroll = Number(settled?.debtClearedByPayroll || 0)
  const writtenOff = Number(settled?.debtWrittenOff || 0)
  const hasSettled = byPayroll > 0.009 || writtenOff > 0.009
  const hasWriteoffs = data && (data.error
    || data.prCost > 0 || data.damageCost > 0 || data.foodValue > 0)
  if (!hasWriteoffs && !hasSettled) return null

  return (
    <>
          {!!data?.error && (
            <div className="mt-3 pt-3 border-t-2 border-line">
              <p className="text-clay text-sm">
                PR and damage could not be loaded ({data.error}). The totals above are unaffected.
              </p>
            </div>
          )}

          {!!data && !data.error
            && (data.prCost > 0 || data.damageCost > 0 || data.foodValue > 0) && (
            <div className="mt-3 pt-3 border-t-2 border-line">
              <div className="text-dim text-sm mb-2">
                Not money. Not part of the total above, and nothing to hand over.
              </div>

              {data.pr.length > 0 && (
                <div className="mb-3">
                  <div className="flex justify-between">
                    <span className="font-semibold">PR / complimentary (at cost)</span>
                    <span className="tnum font-bold">{naira(data.prCost)}</span>
                  </div>
                  {data.pr.map((l, i) => (
                    <div key={i} className="flex justify-between text-sm pl-4 mt-1">
                      <span className="text-dim truncate pr-2">
                        · {l.name} × {l.qty}
                        {l.note && ` — ${l.note}`}
                        {l.who && ` · ${l.who}`}
                      </span>
                      <span className="tnum text-dim shrink-0">{naira(l.cost)}</span>
                    </div>
                  ))}
                </div>
              )}

              {data.damage.length > 0 && (
                <div className="mb-3 rounded-xl border border-clay px-3 py-2">
                  <div className="flex justify-between">
                    <span className="font-semibold text-clay">Damaged / lost (at cost)</span>
                    <span className="tnum font-bold text-clay">{naira(data.damageCost)}</span>
                  </div>
                  {data.damage.map((l, i) => (
                    <div key={i} className="flex justify-between text-sm mt-1">
                      <span className="text-dim truncate pr-2">
                        · {l.name} × {l.qty}
                        {l.reason && ` · ${l.reason}`}
                        {l.note && ` — ${l.note}`}
                        {l.who && ` · ${l.who}`}
                      </span>
                      <span className="tnum text-dim shrink-0">{naira(l.cost)}</span>
                    </div>
                  ))}
                  {/* A reason is asked for at entry; if one is missing
                      say so rather than leave a silent gap. */}
                  {data.damage.some(l => !l.reason) && (
                    <p className="text-clay text-xs mt-2">
                      Some lines have no reason recorded — worth asking who entered them.
                    </p>
                  )}
                </div>
              )}

              {data.foodValue > 0 && (
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="text-dim">Restaurant PR / damage (menu value)</span>
                    <span className="tnum text-dim">{naira(data.foodValue)}</span>
                  </div>
                  {data.food.map((l, i) => (
                    <div key={i} className="flex justify-between text-sm pl-4 mt-1">
                      <span className="text-dim truncate pr-2">
                        · {l.name} × {l.qty}{l.meal && ` · ${l.meal}`}
                        {l.reason && ` · ${l.reason}`}
                      </span>
                      <span className="tnum text-dim shrink-0">{naira(l.value)}</span>
                    </div>
                  ))}
                  <p className="text-dim text-xs mt-1">
                    Food is not stock-tracked, so there is no cost figure for meals —
                    the ingredients were expensed when bought. Menu value shown instead,
                    and NOT added to the costs above.
                  </p>
                </div>
              )}
            </div>
          )}

      {/* Debt settled with NO money changing hands — deducted from wages
          or written off. Both are correctly excluded from the day's
          income, which is exactly why they need saying: otherwise a
          large settlement happens with nothing on screen to show for it.
          Separate from PR and damage above: those are stock given away,
          these are debt forgiven or recovered from pay. */}
      {hasSettled && (
        <div className="mt-3 pt-3 border-t-2 border-line">
          <div className="text-dim text-sm mb-1">
            Debt settled without money coming in — not part of the total above.
          </div>
          {byPayroll > 0.009 && (
            <div className="flex justify-between text-sm">
              <span className="text-dim">Deducted from wages</span>
              <span className="tnum">{naira(byPayroll)}</span>
            </div>
          )}
          {writtenOff > 0.009 && (
            <div className="flex justify-between text-sm">
              <span className="text-dim">Written off</span>
              <span className="tnum text-clay">{naira(writtenOff)}</span>
            </div>
          )}
        </div>
      )}
    </>
  )
}
