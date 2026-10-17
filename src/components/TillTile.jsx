import { naira } from '../lib/format'

// A sub-line under Debt recovered. Two levels is all a phone carries,
// so the method split is one short line of text rather than a third.
export function SubLine({ label, value }) {
  return (
    <div className="flex justify-between gap-3 pl-4">
      <span className="text-dim min-w-0">{label}</span>
      <span className="tnum text-dim shrink-0">{naira(value)}</span>
    </div>
  )
}

export function ByMethod({ map, labels }) {
  const parts = Object.entries(map || {}).filter(([, a]) => Number(a) > 0)
  if (!parts.length) return null
  return (
    <p className="text-dim text-xs pl-4">
      {parts.map(([m, a]) => `${labels[m] || m} ${naira(a)}`).join(' · ')}
    </p>
  )
}


// The POS / Cash / Credit tile, and the day's detail folded inside it
// (17 October 2026, Chris's design).
//
// Closed, a page is three figures — which is what someone opens it for.
// Everything else (gross sales, what was received, debts recovered,
// what is still owed, write-offs) is one tap away instead of a column
// of numbers to scroll past on a phone.
//
// ONE component for both the Sales page and Daily sales. They showed
// the same day in two hand-written panels before, which is how the two
// pages came to disagree about room-bill money in the first place.
//
// A covered tile does not open. The detail states the day's takings
// outright, so letting it expand before the count would hand over the
// very answer the cover exists to withhold.
export default function TillTile({
  title = 'What you should have in hand',
  figures,            // [{ label, value }] — two or three
  note, hidden = false, checkError = null,
  open, onToggle, children,
}) {
  const cols = figures.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
  const canOpen = !hidden && !!children

  const Fig = ({ label, value }) => (
    <div className="min-w-0">
      <div className="text-dim text-sm">{label}</div>
      {hidden
        ? <div className="tnum font-bold text-dim tracking-widest">•••</div>
        : <div className="tnum font-bold truncate">{naira(value)}</div>}
    </div>
  )

  const head = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold text-sm">{title}</p>
        {hidden ? (
          <span className="text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5 shrink-0">
            Count first
          </span>
        ) : canOpen && (
          <span className="text-dim text-xs shrink-0 flex items-center gap-1">
            {open ? 'Hide detail' : "The day's detail"}
            <svg viewBox="0 0 20 20" className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
                 fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
      <div className={`grid ${cols} gap-3 mt-2`}>
        {figures.map(f => <Fig key={f.label} label={f.label} value={f.value} />)}
      </div>
    </>
  )

  return (
    <div className={`mt-3 rounded-2xl border bg-surface p-4 ${hidden ? 'border-amber/50' : 'border-line'}`}>
      {canOpen
        // A real button, so it answers to a tap, a keyboard and a screen
        // reader alike. Full width: on a phone the whole card is the
        // target, not a chevron the size of a grain of rice.
        ? <button type="button" onClick={onToggle} aria-expanded={!!open}
                  className="w-full text-left">{head}</button>
        : head}

      {checkError && hidden ? (
        <p className="text-clay text-xs mt-3">
          The app could not check whether this till has been counted, so the figures stay
          covered. This is a fault, not a rule — tell the GM. ({checkError})
        </p>
      ) : hidden ? (
        <p className="text-amber text-xs mt-3">
          These are hidden until you have counted. Type your POS slip and your drawer into
          Match your Total Sales below — they fill in the moment you save, and the app tells
          you whether it agrees. The day&#39;s detail opens here once you have.
        </p>
      ) : (note && <p className="text-dim text-xs mt-2">{note}</p>)}

      {canOpen && open && (
        <div className="mt-3 pt-3 border-t border-line">{children}</div>
      )}
    </div>
  )
}
