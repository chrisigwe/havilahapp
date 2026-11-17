// Calendar arithmetic, which must give the same answer on a phone in
// Lagos, in London and in Los Angeles. addDays once parsed at LOCAL
// midnight, so on any UTC+ device it came back a day EARLY and every
// new booking defaulted to checking out the day it checked in. Run this
// file under several TZ values; the numbers must not move.
import { addDays, stepDate, stepMonth } from '../src/lib/days.js'

let pass = 0, fail = 0
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}

// The bug the comment on addDays describes, pinned.
ok('a day forward is a day forward', addDays('2026-10-05', 1), '2026-10-06')
ok('a day back is a day back', addDays('2026-10-05', -1), '2026-10-04')
ok('no move is no move', addDays('2026-10-05', 0), '2026-10-05')

ok('over a month end', addDays('2026-10-31', 1), '2026-11-01')
ok('back over a month start', addDays('2026-11-01', -1), '2026-10-31')
ok('over a year end', addDays('2026-12-31', 1), '2027-01-01')
ok('back over a year start', addDays('2027-01-01', -1), '2026-12-31')
ok('a leap day exists', addDays('2028-02-28', 1), '2028-02-29')
ok('a non-leap February does not', addDays('2027-02-28', 1), '2027-03-01')
ok('a timestamp is cut to its date', addDays('2026-10-05T23:30:00Z', 1), '2026-10-06')

const TODAY = '2026-11-17'

ok('stepping back', stepDate('2026-11-17', -1, TODAY), '2026-11-16')
ok('stepping back over a month start', stepDate('2026-11-01', -1, TODAY), '2026-10-31')
ok('stepping forward below the ceiling', stepDate('2026-11-15', 1, TODAY), '2026-11-16')

// There is no credit to look at in the future, so the ceiling holds.
ok('stepping onto the ceiling is allowed', stepDate('2026-11-16', 1, TODAY), '2026-11-17')
ok('stepping past the ceiling stays put', stepDate('2026-11-17', 1, TODAY), '2026-11-17')
ok('a date already past the ceiling does not advance',
   stepDate('2026-11-20', 1, TODAY), '2026-11-20')
ok('the ceiling never blocks going back', stepDate('2026-11-20', -1, TODAY), '2026-11-19')

ok('no ceiling means no limit', stepDate('2026-11-17', 1, null), '2026-11-18')

// Nothing chosen yet: there is no day to move from.
ok('an empty date steps nowhere', stepDate('', -1, TODAY), '')
ok('a null date steps nowhere', stepDate(null, -1, TODAY), null)
ok('an undefined date steps nowhere', stepDate(undefined, 1, TODAY), undefined)

const THIS_MONTH = '2026-11'

ok('a month back', stepMonth('2026-11', -1, THIS_MONTH), '2026-10')
ok('back over a year start', stepMonth('2027-01', -1, THIS_MONTH), '2026-12')
ok('forward below the ceiling', stepMonth('2026-09', 1, THIS_MONTH), '2026-10')
ok('forward onto the ceiling', stepMonth('2026-10', 1, THIS_MONTH), '2026-11')
ok('forward past the ceiling stays put', stepMonth('2026-11', 1, THIS_MONTH), '2026-11')
ok('the ceiling never blocks going back', stepMonth('2027-03', -1, THIS_MONTH), '2027-02')

// Going back from a 31-day month must not roll through a short one.
ok('October back to September', stepMonth('2026-10', -1, THIS_MONTH), '2026-09')
ok('March back to February', stepMonth('2026-03', -1, THIS_MONTH), '2026-02')
ok('a full year back', stepMonth('2026-11', -12, THIS_MONTH), '2025-11')

ok('an empty month steps nowhere', stepMonth('', -1, THIS_MONTH), '')
ok('a null month steps nowhere', stepMonth(null, -1, THIS_MONTH), null)

console.log(`\ndates: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
