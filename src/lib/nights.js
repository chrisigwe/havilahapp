// No imports, on purpose. This file is one calculation and nothing
// else, so plain node can load it and tools/nights.test.mjs can put
// thirteen real stays through it without a database client or a
// browser. A figure the GM reads off the dashboard should be one that
// has been tested, not one that merely compiles.
//
// addDays is copied from format.js rather than imported for that
// reason. It is four lines and it is written in UTC deliberately: the
// version before it parsed at LOCAL midnight, which on a Lagos phone
// (UTC+1) returned the day BEFORE, and that bug shortened this very
// window by a day.
const addDays = (iso, n) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Nights sold by one stay inside a window — one per room per night
// (Chris, 20 October 2026).
//
// This used to count BOOKINGS: a guest who stayed five nights counted
// once, and a guest who arrived last month and is still here counted not
// at all, because the count keyed off check_in_date falling inside the
// month. Both are rooms sold every night they were in the bed.
//
// A night belongs to the day it starts on. A guest who checks in on the
// 18th and leaves on the 20th slept the nights of the 18th and the 19th
// — two nights, not three. The day they leave is not a night sold.
//
// Exported so it can be tested on its own, which is the only way to be
// sure of a figure like this before it is shown to anybody.
export function nightsInWindow(stay, fromDate, toExclusive, today) {
  // Not arrived: a reservation is not a room sold. It becomes one the
  // day the guest walks in, which is also how the room board and the
  // outstanding figure already treat it.
  if (!stay || stay.status === 'reserved') return 0
  const start = stay.check_in_date
  if (!start) return 0

  let end = stay.status === 'checked_out'
    ? (stay.actual_out || stay.scheduled_out)
    : stay.scheduled_out

  // A checkout undone to fix something is not a guest back in the bed
  // (Chris, 20 October 2026). While a stay sits reopened its status
  // reads 'occupied' and its actual_out has been cleared, so the rule
  // below would count a night for every day the correction took — nights
  // nobody slept and nobody paid for. The date they really left is kept
  // in pre_reopen_actual_out by the trigger from 459, and cleared again
  // when they are checked out properly, so this only applies during the
  // correction itself.
  if (stay.status !== 'checked_out' && stay.pre_reopen_actual_out) {
    end = stay.pre_reopen_actual_out
  } else if (stay.status === 'occupied' && (!end || end <= today)) {
    // Someone genuinely still in the room is in it tonight, whatever
    // their scheduled date said — the same rule availability already
    // uses when deciding whether a room is free (see roomsFreeBetween).
    end = addDays(today, 1)
  }
  if (!end) return 0

  // Checked in and out on one day: no night was slept, but the room was
  // sold and could not be let to anyone else. Counted as one.
  if (end <= start) return (start >= fromDate && start < toExclusive) ? 1 : 0

  const a = start > fromDate ? start : fromDate
  const b = end < toExclusive ? end : toExclusive
  if (b <= a) return 0
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5)
}
