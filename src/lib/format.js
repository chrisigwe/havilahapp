import { OVERSIGHT } from './roles'
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
// n days before `from` (default today). The optional anchor exists for
// pages where the date is a control rather than always "now" — Daily
// Sales anchors its prior-day snapshot to the date being browsed.
// Midday avoids any DST/offset rollover when stepping the date.
export const lagosDaysAgo = (n, from) => {
  const d = new Date((from || lagosToday()) + 'T12:00:00')
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
// Restaurant specifically (not itself flagged as a sales point in the
// schema, but exactly what a restaurant order needs). Excludes
// Housekeeping, Others, and the store itself — nothing there should
// ever be sold or charged to a guest. One definition shared by the
// room-charge flow and the restaurant-order flow so they can't drift.
export const orderableLocations = (allLocations) =>
  (allLocations || []).filter(l => !l.is_store && (l.is_sales_point || /restaurant/i.test(l.name)))

// Mirrors the database's own generated column exactly (guests.name_key
// is GENERATED ALWAYS using this identical pattern) — needed client-side
// because a generated column can't be searched against directly; this
// computes the same key to look an existing guest up by.
export const nameKey = (name) =>
  String(name || '').toLowerCase()
    .replace(/^\s*(mr|mrs|ms|miss|dr|chief|engr|elder|pastor|prof|alhaji|hajia)\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '')

export const nightsBetween = (from, to) =>
  Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5))

export const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const CYCLE_LABELS = { one_off: 'One-off', daily: 'Daily', monthly: 'Monthly', pr: 'PR (free)' }
const CYCLE_ORDER = ['one_off', 'daily', 'monthly', 'pr']
// Which billing cycles a branch actually offers — confirmed directly
// against the live database rather than assumed: Nnewi has no
// 'monthly', Awka does. Falls back to all four if the branch's own
// list hasn't loaded yet.
export const cyclesFor = (allowedCycles) => {
  const allowed = allowedCycles || CYCLE_ORDER
  return CYCLE_ORDER.filter(c => allowed.includes(c)).map(value => ({ value, label: CYCLE_LABELS[value] }))
}

// Translates the specific Postgres errors check-in can actually hit
// into something a person can act on, rather than a raw constraint
// name. Matches the exact constraints confirmed on the live stays
// table (stays_one_live_per_room, stay_dates_ordered).
export function friendlyStayError(error) {
  if (!error) return null
  const msg = error.message || String(error)
  if (error.code === '23505' && msg.includes('stays_one_live_per_room')) {
    return 'That room already has a guest checked in or reserved. Check them out first, or pick another room.'
  }
  if (error.code === '23514' && msg.includes('stay_dates_ordered')) {
    return 'The check-out date cannot be before the check-in date.'
  }
  if (error.code === '42501' || msg.includes('row-level security')) {
    return 'You do not have permission to do that for this branch.'
  }
  return msg
}

// Clock time of an actual check-in, in Lagos time. Returns '' when
// the stay predates the checked_in_at column so callers can simply
// omit it rather than print a fabricated time.
export const lagosTime = (ts) => !ts ? '' : new Date(ts).toLocaleTimeString('en-NG', {
  timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: true,
})

// Who may see arrival/departure clock times on guest lists. Front
// desk and bar staff see the DATES as before; only these roles see
// the stamped time. 'storekeeper' is the Store Manager.
export const SEES_STAY_TIMES = OVERSIGHT
export const seesStayTimes = (role) => SEES_STAY_TIMES.includes(role)

// Which department a screen should open on.
//
// Every department-chip screen used to do `staff.default_location_id ||
// list[0]`, trusting the default blindly. That breaks the moment the
// default isn't in that screen's list — e.g. a store manager whose
// default is the Store, on a screen whose list excludes stores. The page
// then opened on a department that doesn't exist on it, and its own
// "reset if invalid" logic reset straight back to the same bad value.
//
// Order: the person's default, if it's on this screen; else the first
// department they're actually assigned to that's on this screen; else
// the first on the list.
export const startingDept = (list, staff, own = []) => {
  const ids = new Set((list || []).map(l => l.id))
  if (staff?.default_location_id && ids.has(staff.default_location_id)) return staff.default_location_id
  const mine = (own || []).find(l => ids.has(l.id))
  if (mine) return mine.id
  return list?.[0]?.id ?? null
}
