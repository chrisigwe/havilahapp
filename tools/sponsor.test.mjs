// The organisation account is one subtraction, and the page prints
// sentences about it that somebody will forward to a university. Every
// one of them is replayed here against figures that can be checked by
// hand, including the day the account goes from in-funds to owing,
// which is the moment the wording has to change without anyone editing
// anything.
import { sponsorTotals, burn, weeksLeft, isLow, sponsorStanding,
         roundWeeks, oldestUnfunded, byMonth, splitStay, rebateOwed } from '../src/lib/sponsor.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`) }
}
const near = (name, got, want) => eq(name, Math.round(Number(got) * 100) / 100, want)

const money = (n) => 'N' + Number(n).toLocaleString('en-NG')
const paid = (paid_on, amount) => ({ paid_on, amount })
const draw = (business_date, amount) => ({ business_date, amount })

// The real position at Awka on 25 November 2026: one million in,
// eight stays out between the 18th and the 21st.
const UNIZIK_IN = [paid('2026-11-17', 1000000)]
const UNIZIK_OUT = [
  draw('2026-11-18', 80000), draw('2026-11-18', 85000), draw('2026-11-18', 90000),
  draw('2026-11-18', 90000), draw('2026-11-18', 90000), draw('2026-11-18', 90000),
  draw('2026-11-21', 90000), draw('2026-11-21', 45000),
]

eq('the live account', sponsorTotals(UNIZIK_IN, UNIZIK_OUT),
   { paid: 1000000, used: 660000, balance: 340000 })
eq('nothing paid, nothing drawn', sponsorTotals([], []), { paid: 0, used: 0, balance: 0 })
eq('drawn with nothing paid in is a debt',
   sponsorTotals([], [draw('2026-11-18', 5000)]), { paid: 0, used: 5000, balance: -5000 })

// Figures that arrive as strings from PostgREST must not concatenate.
eq('numeric columns arriving as text',
   sponsorTotals([paid('2026-11-17', '1000000.00')], [draw('2026-11-18', '90000.00')]),
   { paid: 1000000, used: 90000, balance: 910000 })
eq('a null amount counts as nothing',
   sponsorTotals([paid('2026-11-17', null)], []), { paid: 0, used: 0, balance: 0 })

// Burn: everything in the window, nothing outside it.
eq('all of it inside the month', burn(UNIZIK_OUT, '2026-11-25').used, 660000)
eq('a draw older than the window', burn([draw('2026-09-01', 50000)], '2026-11-25').used, 0)
eq('a draw exactly on today counts', burn([draw('2026-11-25', 1000)], '2026-11-25').used, 1000)
eq('a draw 30 days back is outside', burn([draw('2026-10-26', 1000)], '2026-11-25').used, 0)
eq('a draw 29 days back is inside', burn([draw('2026-10-27', 1000)], '2026-11-25').used, 1000)
eq('no today, no claim', burn(UNIZIK_OUT, null).used, 0)

near('the rate per day', burn(UNIZIK_OUT, '2026-11-25').perDay, 22000)

// Runway. The questions that do not arise return null rather than
// Infinity, because Infinity formats as a sentence nobody can read.
near('weeks of runway', weeksLeft(340000, 22000), 2.21)
eq('nothing being drawn', weeksLeft(340000, 0), null)
eq('nothing left to draw', weeksLeft(0, 22000), null)
eq('already in debt', weeksLeft(-5000, 22000), null)

eq('a fifth left is low', isLow(200000, 1000000), true)
eq('a third left is not', isLow(330000, 1000000), false)
eq('exactly nothing left is low', isLow(0, 1000000), true)
eq('owing is low', isLow(-5000, 1000000), true)
eq('nothing ever paid in', isLow(0, 0), false)

// The three states, as the card prints them.
const inFunds = sponsorStanding({ paidIn: UNIZIK_IN, drawn: UNIZIK_OUT,
                                  today: '2026-11-25', money })
eq('in funds: tone', inFunds.tone, 'funds')
eq('in funds: headline', inFunds.headline, 'N340,000 left')
eq('in funds: detail', inFunds.detail,
   'N660,000 used in the last 30 days — about 2 weeks at this rate')

const low = sponsorStanding({ paidIn: UNIZIK_IN,
                              drawn: [...UNIZIK_OUT, draw('2026-11-24', 200000)],
                              today: '2026-11-25', money })
eq('low: tone', low.tone, 'low')
eq('low: headline', low.headline, 'N140,000 left')

const debt = sponsorStanding({ paidIn: UNIZIK_IN,
                               drawn: [...UNIZIK_OUT, draw('2026-11-24', 400000)],
                               today: '2026-11-25', money })
eq('debt: tone', debt.tone, 'debt')
eq('debt: headline', debt.headline, 'N60,000 owed')
eq('debt: detail names the day it tipped', debt.detail, 'Past the account since 2026-11-24')

// A brand new account that has been paid into and not yet drawn on
// must not say "about 0 days at this rate".
const fresh = sponsorStanding({ paidIn: UNIZIK_IN, drawn: [], today: '2026-11-25', money })
eq('fresh: tone', fresh.tone, 'funds')
eq('fresh: headline', fresh.headline, 'N1,000,000 left')
eq('fresh: detail makes no prediction', fresh.detail, 'Nothing drawn in the last 30 days')

// Runway wording. Under a fortnight it must say days: "about 1 week"
// with nine days left is the rounding that gets somebody caught short.
eq('nine days', roundWeeks(9 / 7), '9 days')
eq('a fortnight', roundWeeks(2), '2 weeks')
eq('five weeks', roundWeeks(5), '5 weeks')
eq('a quarter', roundWeeks(13), '3 months')
eq('a very long way off', roundWeeks(90), 'over a year')
eq('no runway at all', roundWeeks(0), '0 days')
eq('a negative runway cannot be printed', roundWeeks(-3), '0 days')

// The day the account tipped.
eq('never tipped', oldestUnfunded(UNIZIK_IN, UNIZIK_OUT), null)
eq('tipped on the last draw',
   oldestUnfunded([paid('2026-11-17', 100000)],
                  [draw('2026-11-18', 60000), draw('2026-11-20', 60000)]), '2026-11-20')
// Money paid in on the same day as a draw lands first, so a payment
// that arrives to cover a stay does not read as a day in debt.
eq('paid in on the same day it was drawn',
   oldestUnfunded([paid('2026-11-20', 60000)], [draw('2026-11-20', 60000)]), null)
eq('drawn with nothing ever paid in',
   oldestUnfunded([], [draw('2026-11-18', 5000)]), '2026-11-18')

// Months, newest first, each adding up.
const months = byMonth([draw('2026-11-18', 90000), draw('2026-10-02', 45000),
                        draw('2026-11-21', 45000)])
eq('three draws, two months', months.map(m => [m.month, m.total]),
   [['2026-11', 135000], ['2026-10', 45000]])
eq('newest day first inside a month',
   byMonth(UNIZIK_OUT)[0].rows[0].business_date, '2026-11-21')
eq('a row with no date is left out', byMonth([{ amount: 500 }]).length, 0)

// The split. Room, over-stay and food are the university's; drinks and
// minimart are the guest's own.
const folio = { room_charge: 90000, room_change_charge: 0, overstay_charge: 5000 }
eq('an ordinary UNIZIK stay',
   splitStay(folio, { food: 7500, drink: 4200, minimart: 1000 }),
   { room: 90000, overstay: 5000, food: 7500, drink: 4200, minimart: 1000,
     sponsor: 102500, guest: 5200, total: 107700 })

// The Coke billed as Restaurant food, moved across by hand.
eq('a drink moved to the guest',
   splitStay(folio, { food: 7500, drink: 0, minimart: 0 }, { toGuest: 1500 }),
   { room: 90000, overstay: 5000, food: 7500, drink: 0, minimart: 0,
     sponsor: 101000, guest: 1500, total: 102500 })

eq('something moved onto the university',
   splitStay(folio, { food: 0, drink: 3000, minimart: 0 }, { toSponsor: 3000 }),
   { room: 90000, overstay: 5000, food: 0, drink: 3000, minimart: 0,
     sponsor: 98000, guest: 0, total: 98000 })

// A complimentary stay bills the room at nothing, and the split must
// not invent a charge for it.
eq('a PR stay',
   splitStay({ room_charge: 0, room_change_charge: 0, overstay_charge: 0 },
             { food: 0, drink: 2500, minimart: 0 }),
   { room: 0, overstay: 0, food: 0, drink: 2500, minimart: 0,
     sponsor: 0, guest: 2500, total: 2500 })

// Whatever is moved, the two sides still add up to the whole bill.
for (const mv of [0, 500, 7500, -2000]) {
  const s = splitStay(folio, { food: 7500, drink: 4200, minimart: 1000 }, { toGuest: mv })
  if (Math.abs(s.total - 107700) > 0.009) {
    fail++; console.log(`  FAIL moving ${mv} changed the bill total -> ${s.total}`)
  } else { pass++; console.log(`  ok   moving ${mv} leaves the bill total alone`) }
}

// The rebate to the Protocol Officer. Havilah owes it, the university
// pays the full rate and is never told, so these figures must never
// reach the statement — they are kept in their own function for that
// reason.
const stay = (stay_id, nights, amount) => ({ stay_id, nights, amount,
                                             business_date: '2026-11-18' })
// The eight real November stays: 2 nights each but Prof Casmir's one.
const NOV = [stay('a', 2, 80000), stay('b', 2, 85000), stay('c', 2, 90000),
             stay('d', 2, 90000), stay('e', 2, 90000), stay('f', 2, 90000),
             stay('g', 2, 90000), stay('h', 1, 45000)]

eq('fifteen nights at five thousand',
   rebateOwed({ draws: NOV, perNight: 5000 }),
   { nights: 15, stays: 8, rate: 5000, earned: 75000, paid: 0, owed: 75000 })

eq('after paying him fifty',
   rebateOwed({ draws: NOV, perNight: 5000, payouts: [{ amount: 50000 }] }).owed, 25000)

eq('paid in full', rebateOwed({ draws: NOV, perNight: 5000,
                                payouts: [{ amount: 75000 }] }).owed, 0)
eq('overpaid reads as a credit against him',
   rebateOwed({ draws: NOV, perNight: 5000, payouts: [{ amount: 80000 }] }).owed, -5000)

// A stay settled in two payments is two draws and ONE stay. Paying a
// man twice for the same night is the error this guards.
eq('one stay settled by two payments',
   rebateOwed({ draws: [stay('a', 2, 40000), stay('a', 2, 50000)], perNight: 5000 }),
   { nights: 2, stays: 1, rate: 5000, earned: 10000, paid: 0, owed: 10000 })

eq('no agreement means nothing owed',
   rebateOwed({ draws: NOV, perNight: 0 }).owed, 0)
eq('nothing drawn yet', rebateOwed({ draws: [], perNight: 5000 }).owed, 0)
eq('a draw with no stay behind it is not counted',
   rebateOwed({ draws: [{ nights: 2, amount: 100 }], perNight: 5000 }).nights, 0)
eq('rates arriving as text', rebateOwed({ draws: NOV, perNight: '5000.00' }).earned, 75000)

// Meals are draws too, but they are not nights. A meal row carrying
// its stay's id would claim that stay first and hide the night count
// behind a zero, so meal rows carry no stay and the page hands
// rebateOwed only the room draws.
const MEALS = [{ kind: 'meal', id: 'm1', stay_id: null, nights: 0, amount: 12000 },
               { kind: 'meal', id: 'm2', stay_id: null, nights: 0, amount: 11000 }]
const ROOMS = NOV.map(r => ({ ...r, kind: 'room' }))

eq('meals mixed in do not change the nights owed',
   rebateOwed({ draws: [...ROOMS, ...MEALS], perNight: 5000 }).nights, 15)
eq('and do not change what is owed',
   rebateOwed({ draws: [...ROOMS, ...MEALS], perNight: 5000 }).owed, 75000)
// The failure this guards: a meal row that DID carry its stay's id.
eq('a meal wearing its stay id would have hidden the nights',
   rebateOwed({ draws: [{ stay_id: 'a', nights: 0, amount: 12000 }, stay('a', 2, 80000)],
                perNight: 5000 }).nights, 0)

// Money already spoken for. The headline answers "what is left to
// spend", so the fee owed onward comes off it -- but `gross` carries
// the organisation's own balance for the statement, which must never
// mention the arrangement.
const MEALS_IN = [paid('2026-11-18', 1000000)]
const CONSUMED = [...UNIZIK_OUT, draw('2026-11-18', 144500)]
const net = sponsorStanding({ paidIn: MEALS_IN, drawn: CONSUMED,
                              today: '2026-11-25', money, setAside: 75000 })
eq('the headline is what is left to spend', net.headline, 'N120,500 left')
eq('the gross stays available for the statement', net.gross, 195500)
eq('and the set-aside is carried', net.setAside, 75000)

const noAside = sponsorStanding({ paidIn: MEALS_IN, drawn: CONSUMED,
                                  today: '2026-11-25', money })
eq('no set-aside leaves gross and balance equal', noAside.gross, noAside.balance)

// Set aside more than is left and the account reads as owing, which is
// true: the money is promised and not there.
const over = sponsorStanding({ paidIn: MEALS_IN, drawn: CONSUMED,
                               today: '2026-11-25', money, setAside: 250000 })
eq('set aside past the balance reads as owed', over.tone, 'debt')
eq('and the gross is untouched', over.gross, 195500)

console.log(`\nsponsor: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
