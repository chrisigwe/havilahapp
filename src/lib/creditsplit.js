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
// slices  - one row per person owed at that department:
//           { staffId, balance, firstCreditDate, lastCreditDate }
// amount  - what was taken
// fallbackStaffId - who carries money that answers to no debt, when there
//           is no one at that department to give it to
//
// Returns [{ staffId, amount }], one entry per person, never more than one
// each, and always summing to the amount taken.
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

  const parts = []
  const give = (staffId, amt) => {
    const had = parts.find(p => p.staffId === staffId)
    if (had) had.amount = round(had.amount + amt)
    else parts.push({ staffId, amount: round(amt) })
  }

  let pot = total
  for (const s of owed) {
    if (pot <= 0.009) break
    const take = Math.min(pot, round(s.balance))
    give(s.staffId, take)
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
    give(recent ? recent.staffId : fallbackStaffId, pot)
  }
  return parts
}
