// HOW MUCH OF EACH MONTH HAS NEVER BEEN PAID FOR.
//
// Chris, 20 November 2026, relaying the Auditor, the Manager and the
// Store Manager: "days collapsing into months and months into years --
// a better fit for chasing than one card per person."
//
// This is NOT a balance as at a date. "What each owed at the end of
// October" asks where a person stood on the 31st; this asks how much of
// the credit GIVEN in October has still not been paid for. The two read
// alike and answer different questions, and the page labels them apart.
//
// It is only honest from 20 November 2026. Until the date fence went
// into allocate_credit_repayment that morning, a September payment
// could settle a November charge, so a month's outstanding figure moved
// whenever somebody paid. Now a month's total stays that month's.
//
// Takes credit_chain rows exactly as the page already holds them, so
// the view costs one pass over an array and no query at all.
export function ageByMonth(rows, locationId) {
  const years = new Map()
  for (const r of rows || []) {
    // 'all', null and undefined all mean every department.
    if (locationId && locationId !== 'all' && r.location_id !== locationId) continue
    const mk = String(r.taken_on || '').slice(0, 7)
    // A row with no date cannot be placed in a month. Dropping it would
    // make the months disagree with the page total, so the caller is
    // told about it rather than it vanishing quietly.
    if (mk.length !== 7) continue
    const yk = mk.slice(0, 4)
    const amount = Number(r.amount || 0)
    const owed = Number(r.still_owed || 0)

    let y = years.get(yk)
    if (!y) { y = { key: yk, given: 0, owed: 0, months: new Map() }; years.set(yk, y) }
    y.given += amount; y.owed += owed

    let m = y.months.get(mk)
    if (!m) { m = { key: mk, given: 0, owed: 0, people: new Map() }; y.months.set(mk, m) }
    m.given += amount; m.owed += owed

    const pid = r.customer_id
    let person = m.people.get(pid)
    if (!person) {
      person = { id: pid, name: r.customer || '(no name)', given: 0, owed: 0, rows: [] }
      m.people.set(pid, person)
    }
    person.given += amount; person.owed += owed; person.rows.push(r)
  }

  // Newest first everywhere: an auditor opens on the month just gone and
  // works back. Within a month the biggest debt first, which is where
  // the money is -- the same order the person list already uses. Name
  // breaks a tie so the order does not shuffle between loads.
  const byOwed = (a, b) => b.owed - a.owed || String(a.name).localeCompare(String(b.name))
  return [...years.values()]
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(y => ({
      ...y,
      months: [...y.months.values()]
        .sort((a, b) => b.key.localeCompare(a.key))
        .map(m => ({ ...m, people: [...m.people.values()].sort(byOwed) })),
    }))
}

// What the rollup could not place, so the page can say so rather than
// quietly showing a smaller total than the figure above it.
export function undatedRows(rows, locationId) {
  return (rows || []).filter(r =>
    (!locationId || locationId === 'all' || r.location_id === locationId)
    && String(r.taken_on || '').slice(0, 7).length !== 7)
}
