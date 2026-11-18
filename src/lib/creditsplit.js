// How a repayment taken at the front desk is divided among the people who
// actually gave the credit (Chris, 9 November 2026).
//
// Kept apart from data.js, and free of any import, so the arithmetic that
// decides whose debt a payment clears can be tested on its own. We are
// dealing with money: the rule belongs somewhere it can be read in full
// and proved, not buried in a save.
//
// The fault it replaces: a checkout wrote the whole amount under whoever
// was standing at the desk. Mr Michael's N3,000 went in under Daniel, who
// had served him nothing. It cleared no one's slice, left Chidera's
// N1,500 and Prosper's N1,000 reading unpaid, and put Daniel N3,000 in
// the red, which dragged MainBar's column below zero so the guest fell
// off the bar's own list of who owes.
//
// slices  - one row per person owed, optionally per department:
//           { staffId, locationId?, balance, firstCreditDate, lastCreditDate }
// amount  - what was taken
// fallbackStaffId - who carries money that answers to no debt, when there
//           is no one at that department to give it to
//
// Returns [{ staffId, locationId, amount }], one entry per person per
// department, never more than one each, and always summing to the amount
// taken. locationId is null where the caller did not supply one.
export function splitRepaymentByCredit(slices, amount, fallbackStaffId) {
  const round = n => Math.round(Number(n) * 100) / 100
  const total = round(amount)
  if (!(total > 0.009)) return []

  const owed = (slices || [])
    .filter(s => s && s.staffId && Number(s.balance) > 0.009)
    // Oldest credit first, so a part payment clears the longest-standing
    // debt rather than being smeared across everyone owed. Rows with no
    // date sort last: a slice we know nothing about does not jump ahead
    // of one we do.
    .sort((a, b) =>
      String(a.firstCreditDate || '9999-12-31').localeCompare(String(b.firstCreditDate || '9999-12-31')))

  // A slice may carry the DEPARTMENT it was given at as well as the
  // person (Chris, 18 November 2026). The front desk calls this with the
  // slices of one department, so a person appeared once; the Credit page
  // calls it with everything a customer owes, where the same person can
  // be owed at two departments and the two must not be merged into one
  // row — a repayment is written against a department as well as a
  // person. A slice with no locationId behaves exactly as before.
  const parts = []
  const give = (staffId, locationId, amt) => {
    const had = parts.find(p => p.staffId === staffId && p.locationId === locationId)
    if (had) had.amount = round(had.amount + amt)
    else parts.push({ staffId, locationId, amount: round(amt) })
  }

  let pot = total
  for (const s of owed) {
    if (pot <= 0.009) break
    const take = Math.min(pot, round(s.balance))
    give(s.staffId, s.locationId ?? null, take)
    pot = round(pot - take)
  }

  // More than the debt, or no debt recorded at all. A real overpayment
  // goes to whoever served them there last, because that is who will serve
  // them next - never to someone who gave no credit, which is the whole
  // fault being fixed. With no one to choose, the desk carries it, which
  // is what happened before this existed.
  if (pot > 0.009) {
    const recent = [...owed].sort((a, b) =>
      String(b.lastCreditDate || '').localeCompare(String(a.lastCreditDate || '')))[0]
    give(recent ? recent.staffId : fallbackStaffId,
         recent ? (recent.locationId ?? null) : null, pot)
  }
  return parts
}

// Whose debt AND by what method, when a payment is both (18 November
// 2026).
//
// Credit's collect step used to ask "whose credit is being paid?" and
// take one answer, so a customer clearing debts from two people had to
// be entered twice. splitRepaymentByCredit above answers that question
// without asking — oldest debt first, the same rule the front desk has
// used since 9 November. But a payment can also be split across
// methods, and then there are two orderings to honour at once.
//
// Both lists already sum to the same total, so they are walked
// together: the oldest debt is paid with the first method until one of
// them runs out, then whichever ran out advances. The result is one row
// per (person, department, method) — which is exactly what
// credit_repayments stores, one row per method, as it always has.
//
// debtParts   - [{ staffId, locationId, amount, saleId? }] — from
//               splitRepaymentByCredit, or built from named debts
// methodParts - [{ method, amount }] from paymentParts
export function applyMethods(debtParts, methodParts) {
  const round = n => Math.round(Number(n) * 100) / 100
  const ds = (debtParts || []).map(d => ({ ...d, left: round(d.amount) }))
  const ms = (methodParts || []).map(m => ({ ...m, left: round(m.amount) }))
  const out = []
  let i = 0, j = 0
  while (i < ds.length && j < ms.length) {
    // A part already spent moves the pointer on; this is also what stops
    // a zero-amount row from spinning here forever.
    if (!(ds[i].left > 0.009)) { i++; continue }
    if (!(ms[j].left > 0.009)) { j++; continue }
    const take = round(Math.min(ds[i].left, ms[j].left))
    out.push({ staffId: ds[i].staffId, locationId: ds[i].locationId ?? null,
               // The sale this part clears, when the caller is settling
               // named debts rather than a balance. Carried through so a
               // split payment can still say which debt each method paid
               // (18 November 2026).
               saleId: ds[i].saleId ?? null,
               method: ms[j].method, amount: take })
    ds[i].left = round(ds[i].left - take)
    ms[j].left = round(ms[j].left - take)
  }
  return out
}
