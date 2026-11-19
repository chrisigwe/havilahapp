import { naira, methodLabel } from '../lib/format'
import { paymentParts, paymentAllocated, paymentReady, toggleMethod, setSplitAmount } from '../lib/payments'

// Chips that toggle (Chris, 18 November 2026: "when you tap POS, you can
// enter the POS amount; the same goes for Cash. Tap both, and you get a
// split payment").
//
// It used to be single-method chips plus a separate Split button, which
// revealed a box for EVERY method whether it had been chosen or not. A
// split was a mode you entered rather than something that followed from
// what you tapped — and at a bar at night that is one more thing to
// know. Now: tap one and it carries the whole payment, with the figure
// on the chip so there is nothing to check. Tap a second and boxes
// appear for exactly those two, the other one keeping whatever the one
// you typed has not claimed.
//
// The arithmetic is in lib/payments.js, under test, because it decides
// how much of a payment lands on each method.
//
// value: { method, split } — unchanged, so every sheet that reads it
// through paymentParts/paymentReady is untouched. split is null for one
// method, or { [method]: amountString } for two or more.
export default function PaymentMethodPicker({ methods, amount, value, onChange }) {
  const { method, split } = value
  const chosen = split ? Object.keys(split) : (method ? [method] : [])
  const target = Number(amount) || 0

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {methods.map(m => {
          const on = chosen.includes(m)
          const alone = on && !split
          return (
            <button key={m} type="button"
              aria-pressed={on}
              onClick={() => onChange(toggleMethod(value, m, amount))}
              className={`h-12 px-4 rounded-xl border font-semibold ${on
                ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>
              {methodLabel[m] || m}
              {alone && target > 0 && (
                <span className="font-normal tnum"> · {naira(target)}</span>
              )}
            </button>
          )
        })}
      </div>

      {!chosen.length && (
        <p className="text-dim text-sm mt-2">
          Tap how it was paid. Tap both for a split.
        </p>
      )}

      {split && (
        <div className="mt-3">
          {Object.keys(split).map(m => (
            <div key={m} className="flex items-center gap-3 mt-2">
              <span className="w-24 text-dim">{methodLabel[m] || m}</span>
              <input type="number" inputMode="decimal" placeholder="0" value={split[m]}
                onChange={e => onChange(setSplitAmount(value, m, e.target.value, amount))}
                className="h-12 flex-1 min-w-0 px-3 rounded-xl bg-surface border border-line tnum" />
            </div>
          ))}
          {(() => {
            const diff = target - paymentAllocated(value, amount)
            if (Math.abs(diff) < 0.01) {
              return <p className="text-leaf text-sm mt-2">That adds up to {naira(target)}.</p>
            }
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

export { paymentParts, paymentAllocated, paymentReady }
