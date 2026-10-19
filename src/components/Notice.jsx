// One appearance for every warning in the app (19 October 2026).
//
// They had grown up one at a time: a clay sentence here, an amber
// bordered paragraph there, a red-bordered card somewhere else, each
// with its own padding and its own weight. The result was that nothing
// looked more serious than anything else — a note explaining the noon
// rule looked exactly like money being short.
//
// Four tones, and they mean different things:
//
//   problem  something is wrong, or money is at risk. Clay.
//   warn     proceed, but know what you are doing. Amber.
//   good     the thing people were worried about is fine. Leaf.
//   note     an explanation, no alarm at all. Grey.
//
// The shape is the same in all four: a coloured edge down the left, a
// faint wash of the same colour, an icon, and the words. The edge is
// what the eye catches first, so the colour does the work before a word
// is read — and a long explanation no longer has to be loud to be seen.

const TONES = {
  problem: {
    edge: 'border-l-clay', wash: 'bg-clay/10', ring: 'border-clay/30',
    ink: 'text-clay',
    icon: <path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  },
  warn: {
    edge: 'border-l-amber', wash: 'bg-amber/10', ring: 'border-amber/30',
    ink: 'text-amber',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5m0 3.5v.01" /></>,
  },
  good: {
    edge: 'border-l-leaf', wash: 'bg-leaf/10', ring: 'border-leaf/30',
    ink: 'text-leaf',
    icon: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>,
  },
  note: {
    edge: 'border-l-line', wash: 'bg-raise', ring: 'border-line',
    ink: 'text-dim',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8.5v.01" /></>,
  },
}

export default function Notice({ tone = 'note', title, children, className = '' }) {
  const t = TONES[tone] || TONES.note
  return (
    <div role={tone === 'problem' ? 'alert' : undefined}
      className={`rounded-2xl border border-l-4 ${t.ring} ${t.edge} ${t.wash} p-4 ${className}`}>
      <div className="flex gap-3">
        <svg viewBox="0 0 24 24" aria-hidden="true"
          className={`w-5 h-5 shrink-0 mt-0.5 ${t.ink}`}
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round">
          {t.icon}
        </svg>
        <div className="min-w-0 flex-1">
          {title && <p className={`font-bold ${t.ink}`}>{title}</p>}
          {/* The body stays readable grey whatever the tone. Coloured
              text is for the figure that is wrong, not for a paragraph
              explaining it — a whole sentence in clay is harder to read
              and no more urgent. */}
          <div className={`text-sm ${title ? 'mt-1 text-dim' : t.ink} [&_b]:text-ink [&_strong]:text-ink`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
