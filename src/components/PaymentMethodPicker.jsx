import { naira, methodLabel } from '../lib/format'

// Single-method chips, with a Split option revealing per-method
// inputs that must sum to `amount`. Extracted here because this
// exact pattern was independently duplicated in Credit and Folio
// (and Sales has its own close cousin) — a fourth copy for Reception's
// guest-payment sheet was the point where drift risk outweighed
// leaving it inline.
//
// value: { method, split } — split is null for single-method, or
// { [method]: amountString } once Split is chosen.
export default function PaymentMethodPicker({ methods, amount, value, onChange }) {
  const { method, split } = value
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {methods.map(m => (
          <button key={m} type="button" onClick={() => onChange({ method: m, split: null })}
            className={`h-12 px-4 rounded-xl border font-semibold ${!split && method === m
              ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
            {methodLabel[m] || m}
          </button>
        ))}
        <button type="button"
          onClick={() => onChange({ method, split: split || Object.fromEntries(methods.map(m => [m, ''])) })}
          className={`h-12 px-4 rounded-xl border font-semibold ${split
            ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
          Split
        </button>
      </div>

      {split && (
        <div className="mt-3">
          {Object.keys(split).map(m => (
            <div key={m} className="flex items-center gap-3 mt-2">
              <span className="w-24 text-dim">{methodLabel[m] || m}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={split[m]}
                onChange={e => onChange({ method, split: { ...split, [m]: e.target.value } })}
                className="h-12 flex-1 px-3 rounded-xl bg-surface border border-line tnum" />
            </div>
          ))}
          {(() => {
            const allocated = Object.values(split).reduce((s, v) => s + Number(v || 0), 0)
            const target = Number(amount) || 0
            const diff = target - allocated
            if (Math.abs(diff) < 0.01) return <p className="text-dim text-sm mt-2">Splits match the amount.</p>
            return (
              <p className="text-clay text-sm mt-2">
                {diff > 0 ? `${naira(diff)} still unallocated` : `${naira(-diff)} over the amount entered`}
              </p>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// The parts array (method/amount pairs) a save function actually
// needs, computed from the same value shape the picker edits.
export function paymentParts(value, amount) {
  if (value.split) {
    return Object.entries(value.split).map(([method, amt]) => ({ method, amount: Number(amt || 0) }))
  }
  return [{ method: value.method, amount: Number(amount || 0) }]
}

export function paymentAllocated(value, amount) {
  return paymentParts(value, amount).reduce((s, p) => s + p.amount, 0)
}
