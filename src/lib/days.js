// Calendar-date arithmetic, pure and import-free so node can test it.
// Re-exported from format.js, so every existing import site is
// unchanged.
//
// Done ENTIRELY IN UTC, so no device timezone can shift the result. An
// earlier addDays parsed the date at LOCAL midnight and then converted
// to UTC to print it — on a Lagos phone (UTC+1) local midnight is 23:00
// the previous day in UTC, so every call came back one day EARLY:
// addDays('2026-10-05', 1) returned '2026-10-05'. That made the default
// check-out on every new booking the same day as check-in, and
// shortened the "rooms sold this month" window by a day. It only showed
// on UTC+ devices, which is why testing in UTC never caught it.
export const addDays = (iso, n) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Walking a date picker forward or back a day at a time, never past a
// ceiling (Chris, 17 November 2026 — "next and previous buttons for
// easy moving through dates").
//
// Shared by the Credit and Recovered pickers so the two cannot disagree
// about what "next" means at the boundary. An empty date steps nowhere:
// there is no day to move from until one is chosen.
// The ceiling stops you going FURTHER forward; it never traps you. A
// date already past it — typed by hand, or left over from a device
// whose clock was wrong — must still step backwards, or the arrows go
// dead and the only way out is the calendar.
export const stepDate = (iso, by, max) => {
  if (!iso) return iso
  const next = addDays(iso, by)
  if (max && by > 0 && next > max) return iso
  return next
}
