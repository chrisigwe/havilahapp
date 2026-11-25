// The segmented switch the Credit page uses for "By person / By month",
// pulled out so Stock and Supplies can have the same control rather
// than three near-copies (Chris, 25 November 2026: "both with the same
// switch tab as the credit page").
//
// Sized by how many options it carries. Two get the full text; three
// or four tighten, because "Balances" in a quarter of a 320px screen
// does not fit at 14px and a clipped label is worse than a small one.
// Beyond four this is the wrong control: use chips that scroll.
export default function SwitchTabs({ options, value, onChange, label }) {
  const tight = options.length > 2
  return (
    <div role="group" aria-label={label}
      className={`flex rounded-xl border border-line bg-surface p-1 ${tight ? 'gap-0.5' : ''}`}>
      {options.map(([k, text]) => (
        <button key={k} type="button" onClick={() => onChange(k)} aria-pressed={value === k}
          className={`flex-1 min-w-0 h-9 rounded-lg font-semibold truncate
                      ${tight ? 'text-[13px] tracking-tight px-0.5' : 'text-sm px-1'}
                      ${value === k ? 'bg-raise text-ink' : 'text-dim'}`}>
          {text}
        </button>
      ))}
    </div>
  )
}
