// How a person's name is written down, so the same guest does not appear as
// FRANK on one receipt and Mr frank on the next. Kept free of imports so the
// checks in tools/ can run it without a browser.
//
// This is tidiness, not matching. Matching is normalize_customer_name, in the
// database and mirrored in customerName.js — it lowercases everything anyway,
// so nothing here can change who matches whom.

// Written in capitals by people who mean them that way. Everything else is
// a name until proven otherwise; this list is deliberately short, because a
// wrong guess here renames a real guest.
const KEEP_UPPER = new Set([
  'HRH', 'PSN', 'GM', 'JP', 'VC', 'MD', 'CEO', 'DPO', 'II', 'III', 'IV',
])

// Mc carries a second capital, and so does anything after an apostrophe or a
// hyphen: O'Neill, McDonald, Chukwuemeka-Obi. Mac is deliberately NOT treated
// the same way — Macaulay and Macon are ordinary names, and turning one into
// MacAulay is a worse mistake than leaving MacArthur as Macarthur.
function capWord(w) {
  if (!w) return w
  const up = w.toUpperCase()
  if (KEEP_UPPER.has(up)) return up
  const lower = w.toLowerCase()
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s
  if (/^mc[a-z]{2,}$/.test(lower)) return 'Mc' + cap(lower.slice(2))
  return lower.split("'").map(cap).join("'")
}

export function tidyName(input) {
  const raw = String(input == null ? '' : input)
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s) return ''
  // A merged-away record is a marker, not a name. Renaming one breaks the
  // merge tool's ability to find the survivor.
  if (/^\[merged into/i.test(s)) return s
  // Anything in brackets is left exactly as typed — it is usually a room
  // number or a job ("(Room 207)", "(staff)"), and guessing at it is how a
  // tidy-up starts changing meaning.
  return s.split(/(\([^)]*\))/).map(part =>
    part.startsWith('(') ? part
      : part.split(' ').map(w => w.split('-').map(capWord).join('-')).join(' ')
  ).join('')
}
