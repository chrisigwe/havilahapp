export const naira = (n) =>
  '₦' + Number(n ?? 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })

// business date in Africa/Lagos regardless of device timezone
export const lagosToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date())

export const tierLabel = { general: 'Standard', lounge: 'Lounge', staff: 'Staff' }
export const methodLabel = { pos: 'POS', cash: 'Cash', credit: 'Credit', transfer: 'Transfer' }

// N days before the Lagos business date — matches lagos_today() - N in
// the database exactly, so app-side windows never disagree with what
// RLS actually permits.
export const lagosDaysAgo = (n) => {
  const d = new Date(lagosToday() + 'T12:00:00')
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// Who a sale is attributed to for display: the person it was
// recorded on behalf of, if any, with a note on who actually typed
// it — otherwise just whoever entered it themselves. One shared
// definition so the Sales list and Daily Sales history can't drift
// apart on this.
export const whoRecorded = (r) =>
  r.stood_in_for?.full_name
    ? `${r.stood_in_for.full_name} (recorded by ${r.recorder?.full_name || 'unknown'})`
    : (r.recorder?.full_name || 'unknown')

// Payment method(s) for a sale row, for list display. A sale can be
// split across methods — shown as "Split: POS + Cash" rather than
// picking one arbitrarily. Unpaid (no sale_payments row at all) is
// named plainly rather than left blank, since that's exactly the
// thing worth noticing on a list.
export const paymentSummary = (r) => {
  const pays = r.sale_payments || []
  if (!pays.length) return 'Unpaid'
  if (pays.length === 1) return methodLabel[pays[0].method] || pays[0].method
  return 'Split: ' + pays.map(p => methodLabel[p.method] || p.method).join(' + ')
}

// Departments that can fulfil an order — real sales points, plus
// Kitchen specifically (not itself flagged as a sales point in the
// schema, but exactly what a restaurant order needs). Excludes
// Housekeeping, Others, and the store itself — nothing there should
// ever be sold or charged to a guest. One definition shared by the
// room-charge flow and the restaurant-order flow so they can't drift.
export const orderableLocations = (allLocations) =>
  (allLocations || []).filter(l => !l.is_store && (l.is_sales_point || /kitchen/i.test(l.name)))
