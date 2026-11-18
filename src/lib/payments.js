// How a payment sheet's method choice turns into rows, and whether it is
// safe to save. Kept free of imports so it can be run straight by the
// checks in tools/, the way creditsplit and openingday are.

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

// Whether the sheet holds a payment that can be saved as entered.
//
// A split used to need only to add up to SOMETHING. Enter N3,000, put
// N1,000 on POS and N500 on cash, and it saved N1,500: the customer was
// credited with less than they handed over, their debt stayed N1,500 too
// high, and the drawer held more than the app said. Over-allocating did
// the reverse. The picker showed the shortfall in red, but red text is not
// a guard (Chris, 12 November 2026).
//
// So a split must now land on the amount entered, to the kobo. A split
// that already added up behaves exactly as before.
export function paymentReady(value, amount) {
  const target = Number(amount) || 0
  if (!(target > 0)) return false
  if (!value.split) return !!value.method
  return Math.abs(paymentAllocated(value, amount) - target) < 0.01
}

// ---- choosing the methods ----
//
// Chris, 18 November 2026: "when you tap POS, you can enter the POS
// amount; the same goes for Cash. Tap both, and you get a split
// payment."
//
// The picker used to have single-method chips plus a separate Split
// button that revealed a box for EVERY method, selected or not. So a
// split was a mode you entered rather than something that followed from
// what you tapped, and the boxes included methods nobody had chosen.
//
// Now the chips are toggles: one is the whole payment, two is a split,
// and the split holds only the methods actually tapped. The arithmetic
// is here rather than in the component because it decides how much of a
// payment lands on each method, and that is money.

const round2 = n => Math.round(Number(n) * 100) / 100
const chosen = value =>
  value.split ? Object.keys(value.split) : (value.method ? [value.method] : [])

// The first chosen method absorbs whatever the others have not claimed,
// so nobody stands at the counter doing subtraction.
function absorb(split, keeper, amount) {
  const others = Object.keys(split).filter(x => x !== keeper)
  const taken = others.reduce((t, x) => t + Number(split[x] || 0), 0)
  return { ...split, [keeper]: String(Math.max(0, round2(Number(amount || 0) - taken))) }
}

export function toggleMethod(value, m, amount) {
  const sel = chosen(value)
  if (sel.includes(m)) {
    const rest = sel.filter(x => x !== m)
    if (!rest.length) return { method: null, split: null }
    if (rest.length === 1) return { method: rest[0], split: null }
    const split = {}
    for (const x of rest) split[x] = value.split[x]
    return { method: rest[0], split: absorb(split, rest[0], amount) }
  }
  if (!sel.length) return { method: m, split: null }
  const split = {}
  for (const x of sel) split[x] = value.split ? value.split[x] : String(round2(amount))
  split[m] = ''
  return { method: sel[0], split: absorb(split, sel[0], amount) }
}

// Typing into one method's box moves the remainder onto another, so the
// two always add up to what is being paid.
export function setSplitAmount(value, m, raw, amount) {
  const split = { ...(value.split || {}), [m]: raw }
  const keeper = Object.keys(split).find(x => x !== m)
  return { ...value, split: keeper ? absorb(split, keeper, amount) : split }
}
