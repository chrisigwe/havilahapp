// An organisation's account — UNIZIK at Awka being the first one.
//
// The whole model is one subtraction. Money the organisation has paid
// in, less the stays drawn against it. A positive balance means they
// are in funds; a negative balance means they owe us. There is no
// second mechanism for the day they run short, because running short
// is the same arithmetic with the other sign.
//
// Nothing here reads the clock or the database: `today` is passed in,
// so every sentence the page prints can be replayed in a test.

export const DAY = 864e5

// How far back the burn rate looks. A month is long enough to survive
// one quiet week and short enough to notice a conference.
export const BURN_DAYS = 30

// Below this, the account wants attention. A fifth of the opening
// payment would scale with the deal; a flat figure would not survive
// their next one being twice the size.
export const LOW_FRACTION = 0.2

const num = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

const asDate = (d) => (d instanceof Date ? d : new Date(String(d) + 'T00:00:00Z'))

const daysBetween = (from, to) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY)

// paidIn:  [{ paid_on, amount }]            money from the organisation
// drawn:   [{ business_date, amount, ... }] folio payments of method 'sponsor'
export function sponsorTotals(paidIn = [], drawn = []) {
  const inTotal = (paidIn || []).reduce((s, r) => s + num(r.amount), 0)
  const outTotal = (drawn || []).reduce((s, r) => s + num(r.amount), 0)
  return { paid: inTotal, used: outTotal, balance: inTotal - outTotal }
}

// What they have drawn in the last BURN_DAYS days, and what that is
// per day. Returns used = 0 when nothing has been drawn, which is a
// real answer and not a missing one.
export function burn(drawn = [], today, days = BURN_DAYS) {
  if (!today) return { used: 0, perDay: 0, days }
  const end = asDate(today)
  const start = new Date(end.getTime() - days * DAY)
  const used = (drawn || [])
    .filter(r => {
      const d = asDate(r.business_date)
      return d > start && d <= end
    })
    .reduce((s, r) => s + num(r.amount), 0)
  return { used, perDay: days > 0 ? used / days : 0, days }
}

// Weeks of runway at the recent rate. Null where the question does not
// arise — nothing drawn recently, or nothing left to draw.
export function weeksLeft(balance, perDay) {
  if (!(perDay > 0)) return null
  if (!(balance > 0)) return null
  return (balance / perDay) / 7
}

// Is the account low enough to say something about? Measured against
// what they last paid in rather than a figure baked into the code, so
// a bigger agreement raises the bar with it.
export function isLow(balance, paid, fraction = LOW_FRACTION) {
  if (!(paid > 0)) return false
  if (balance <= 0) return true
  return balance <= paid * fraction
}

// The one sentence under the headline figure. It has to work in three
// states, and the wording for debt deliberately echoes the Credit
// page ("owes", "oldest since") so the first time it happens nobody
// has to learn a new vocabulary.
//
// Returns { tone, headline, detail } — tone is 'funds' | 'low' | 'debt',
// which is also what the card colours itself by.
// setAside: money inside the balance that is already spoken for and
// cannot be spent on more stays -- the per-night fee owed onward to a
// third party. It changes what the HEADLINE says, because the honest
// answer to "how much is left" is what is left to spend. It must never
// reach the statement: the organisation is not party to that
// arrangement, and `gross` is returned for the document to use.
export function sponsorStanding({ paidIn = [], drawn = [], today,
                                  money = (n) => String(n), setAside = 0 }) {
  const { paid, used, balance: gross } = sponsorTotals(paidIn, drawn)
  const aside = num(setAside)
  const balance = gross - aside
  const b = burn(drawn, today)
  const weeks = weeksLeft(balance, b.perDay)

  if (balance < -0.009) {
    const oldest = oldestUnfunded(paidIn, drawn)
    return {
      tone: 'debt',
      balance, gross, setAside: aside,
      headline: `${money(Math.abs(balance))} owed`,
      detail: oldest
        ? `Past the account since ${oldest}`
        : 'Drawn past what has been paid in',
    }
  }

  const low = isLow(balance, paid)
  const rate = b.used > 0
    ? `${money(b.used)} used in the last ${b.days} days`
    : `Nothing drawn in the last ${b.days} days`
  const runway = weeks == null ? '' : ` — about ${roundWeeks(weeks)} at this rate`

  return {
    tone: low ? 'low' : 'funds',
    balance, gross, setAside: aside,
    headline: `${money(balance)} left`,
    detail: `${rate}${runway}`,
    paid,
    used,
  }
}

// "about 5 weeks", "about 3 days", "about a year" — a figure nobody
// will read as a promise. Under a fortnight it says days, because
// "about 1 week" when there are nine days left is the rounding that
// gets somebody caught short.
export function roundWeeks(weeks) {
  if (!(weeks > 0)) return '0 days'
  const days = weeks * 7
  if (days < 14) return `${Math.max(1, Math.round(days))} days`
  if (weeks < 9) return `${Math.round(weeks)} weeks`
  const months = weeks / 4.345
  if (months < 18) return `${Math.round(months)} months`
  return 'over a year'
}

// The date the account first went past what had been paid in — running
// the draws against the payments in date order. Used only for the debt
// sentence, where "since when" is the question anyone asks next.
export function oldestUnfunded(paidIn = [], drawn = []) {
  const credits = (paidIn || []).map(r => ({ d: String(r.paid_on), amount: num(r.amount) }))
  const debits = (drawn || []).map(r => ({ d: String(r.business_date), amount: -num(r.amount) }))
  const rows = [...credits, ...debits]
    .filter(r => r.d && r.d !== 'null' && r.d !== 'undefined')
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : b.amount - a.amount))
  let running = 0
  for (const r of rows) {
    const was = running
    running += r.amount
    if (was >= -0.009 && running < -0.009) return r.d
  }
  return null
}

// Draws grouped by the month they fall in, newest month first, each
// with its own total — the shape FoldedDays already folds.
export function byMonth(drawn = []) {
  const months = new Map()
  for (const r of drawn || []) {
    const d = String(r.business_date || '')
    if (d.length < 7) continue
    const key = d.slice(0, 7)
    if (!months.has(key)) months.set(key, { month: key, total: 0, rows: [] })
    const m = months.get(key)
    m.total += num(r.amount)
    m.rows.push(r)
  }
  const out = [...months.values()]
  out.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))
  for (const m of out) {
    m.rows.sort((a, b) => (String(a.business_date) < String(b.business_date) ? 1 : -1))
  }
  return out
}

// The rebate owed to a third party for sending the business — UNIZIK's
// Protocol Officer, N5,000 a night (Chris, 25 November 2026).
//
// Havilah owes it; the organisation pays the full rate and is never
// told about it. It must therefore never reach a statement, and the
// two sides are kept apart here so that cannot happen by accident.
//
// Nights are counted per STAY, not per draw. A stay settled in two
// payments is two draws and one stay, and paying a man twice for the
// same night is exactly the error this arithmetic exists to avoid.
export function rebateOwed({ draws = [], perNight = 0, payouts = [] }) {
  const rate = num(perNight)
  const seen = new Set()
  let nights = 0
  for (const d of draws || []) {
    const key = d.stay_id || d.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    nights += num(d.nights)
  }
  const earned = nights * rate
  const paid = (payouts || []).reduce((s, p) => s + num(p.amount), 0)
  return { nights, stays: seen.size, rate, earned, paid, owed: earned - paid }
}

// What a stay costs the organisation, and what it leaves for the guest.
// The split follows the agreement: room, any room-change adjustment and
// the over-stay fee are theirs; food is theirs; drinks and minimart are
// the guest's own. A line moved by hand on the bill overrides the rule,
// which is why `moved` is taken rather than inferred.
//
// folio: a v_stay_folio row. cats: { food, drink, minimart }.
// moved: { toGuest = 0, toSponsor = 0 } — amounts a person reassigned.
export function splitStay(folio = {}, cats = {}, moved = {}) {
  const room = num(folio.room_charge) + num(folio.room_change_charge)
  const overstay = num(folio.overstay_charge)
  const food = num(cats.food)
  const drink = num(cats.drink)
  const minimart = num(cats.minimart)
  const toGuest = num(moved.toGuest)
  const toSponsor = num(moved.toSponsor)

  const sponsor = room + overstay + food - toGuest + toSponsor
  const guest = drink + minimart + toGuest - toSponsor
  return { room, overstay, food, drink, minimart, sponsor, guest, total: sponsor + guest }
}
