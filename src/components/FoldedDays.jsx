import { useMemo, useState } from 'react'
import { foldDays } from '../lib/datefold'

// Draws a day-grouped list with finished months and years folded away
// (Chris, 29 October 2026). The day itself is still drawn by the screen
// that owns it — only the wrapping is shared, so a list keeps its own
// rows, its own totals and its own open/closed behaviour.
//
// Months and years keep their open state here and start closed: the
// point is to get them off the screen until someone asks.
// forceOpen: a node holding something the screen says must be visible
// opens whatever the fold says. Corrections ticks payments for deletion;
// folding away a month that holds a ticked one would offer to delete
// something nobody can see, which is the rule that section already had
// for its days and must not lose by being wrapped.
export default function FoldedDays({ groups, today, renderDay, summary, forceOpen }) {
  const tree = useMemo(() => foldDays(groups, today), [groups, today])
  const [open, setOpen] = useState(() => new Set())
  const toggle = (k) => setOpen(s => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k); else n.add(k)
    return n
  })

  const draw = (nodes) => nodes.map(n => {
    if (n.kind === 'day') return renderDay(n.key, n.items)
    const isOpen = open.has(n.key) || (!!forceOpen && forceOpen(n.items))
    return (
      <section key={n.key} className="mt-4 rounded-2xl border border-line bg-surface">
        <button type="button" onClick={() => toggle(n.key)} aria-expanded={isOpen}
          className="w-full px-4 py-3 flex items-baseline justify-between gap-3 text-left">
          <span className="min-w-0">
            <span className="font-semibold">{n.label}</span>
            <span className="text-dim text-sm block">
              {n.days} {n.days === 1 ? 'day' : 'days'}
            </span>
          </span>
          <span className="flex items-baseline gap-2 shrink-0">
            {summary ? summary(n.items) : null}
            <svg viewBox="0 0 20 20" aria-hidden="true"
                 className={`w-4 h-4 text-dim transition-transform ${isOpen ? 'rotate-180' : ''}`}>
              <path d="M5 7l5 6 5-6" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {isOpen && <div className="px-3 pb-3">{draw(n.children)}</div>}
      </section>
    )
  })

  return <>{draw(tree)}</>
}
