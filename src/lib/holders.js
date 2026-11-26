// Who was holding a login on a given day.
//
// Entries in this app name the ACCOUNT, not the person: a sale shows
// "Chef" because that is the login that recorded it. When a job login
// changes hands the account keeps its name, so an entry from last month
// and one from today both say "Chef" while meaning two different people.
//
// The hand-over screen already records the change, as a dated line
// appended to staff.note by the reset-staff-password function:
//
//   2026-11-21: handed over to Grace Nwosu (by GM)
//   2026-11-03: password reset by GM
//
// Nothing read those lines back, and the page that printed them listed
// only ACTIVE accounts — so switching off a leaver hid the record at
// the exact moment somebody would want it (Chris, 26 November 2026).
//
// Pure, and the date is passed in: who held an account on 18 November
// is a question with one right answer, and it should be answerable in
// a test rather than by reading dates off a screen.

const HANDOVER = /^(\d{4}-\d{2}-\d{2})\s*:\s*handed over to\s+(.+?)\s*$/i
const RESET = /^(\d{4}-\d{2}-\d{2})\s*:\s*password reset by\s+(.+?)\s*$/i
// "(by GM)" at the end of a hand-over line names who did it, not who
// took it on. Stripped from the holder, kept as `by`.
const BY = /^(.*?)\s*\(\s*by\s+(.+?)\s*\)$/i

const lines = (note) => String(note || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)

// Every hand-over on an account, oldest first.
export function handovers(note) {
  const out = []
  for (const line of lines(note)) {
    const m = HANDOVER.exec(line)
    if (!m) continue
    const rest = m[2]
    const b = BY.exec(rest)
    const to = (b ? b[1] : rest).trim()
    if (!to) continue
    out.push({ on: m[1], to, by: b ? b[2].trim() : null })
  }
  out.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))
  return out
}

// Password changes with nobody named — worth showing, because a reset
// is a moment when access changed hands even if no name was typed.
export function resets(note) {
  return lines(note)
    .map(l => RESET.exec(l))
    .filter(Boolean)
    .map(m => ({ on: m[1], by: m[2].trim() }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))
}

// Anything in the note that is not one of those: an ordinary remark
// somebody typed. Kept separate so it is not read as history.
export function otherLines(note) {
  return lines(note).filter(l => !HANDOVER.test(l) && !RESET.test(l))
}

// Who held the account on `date`. The LAST hand-over dated on or before
// that day wins — a login handed over on the 21st was that person's for
// the 21st, because the change happened before the day's entries did.
//
// Returns null when no hand-over covers that date: before the first one
// the account has never changed hands, and saying who held it then would
// be inventing an answer. The caller says "no record" rather than naming
// the current holder, who may not have been there.
export function holderOn(note, date) {
  if (!date) return null
  const d = String(date)
  let found = null
  for (const h of handovers(note)) {
    if (h.on <= d) found = h; else break
  }
  return found ? { name: found.to, since: found.on, by: found.by } : null
}

// The hand-over history as periods, newest first: who held it, from
// when, and until the next hand-over. `until` is null for the current
// holder.
export function heldBy(note) {
  const hs = handovers(note)
  return hs.map((h, i) => ({
    name: h.to, from: h.on, by: h.by,
    until: i + 1 < hs.length ? hs[i + 1].on : null,
  })).reverse()
}
