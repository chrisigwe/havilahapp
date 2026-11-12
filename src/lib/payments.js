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
