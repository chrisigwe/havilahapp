import { splitRepaymentByCredit } from '../src/lib/creditsplit.js'

let pass = 0, fail = 0
const show = p => p.map(x => `${x.staffId}:${x.amount}`).join(' ')
const t = (name, got, want) => {
  const g = show(got)
  if (g === want) { pass++; console.log(`  ok   ${name} -> ${g || '(nothing)'}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${g}", want "${want}"`) }
}
// Every split must hand out exactly what was taken. Checked on each case
// as well as asserted, because a rounding slip here is money gone missing.
const sums = (name, got, want) => {
  const tot = Math.round(got.reduce((a, x) => a + x.amount, 0) * 100) / 100
  if (tot === want) { pass++; console.log(`  ok   ${name} adds up to ${tot}`) }
  else { fail++; console.log(`  FAIL ${name}: parts add to ${tot}, want ${want}`) }
}

const chidera = { staffId: 'chidera', balance: 1500, firstCreditDate: '2026-10-17', lastCreditDate: '2026-11-08' }
const prosper = { staffId: 'prosper', balance: 1000, firstCreditDate: '2026-10-06', lastCreditDate: '2026-11-08' }

// The case that started this: Room 206's N3,000, taken at Reception.
// Prosper gave credit first, so he is cleared first; the N500 above the
// debt stays with him rather than landing on Daniel, who served nothing.
const room206 = splitRepaymentByCredit([chidera, prosper], 3000, 'daniel')
t('Room 206: N3,000 across Prosper and Chidera', room206, 'prosper:1500 chidera:1500')
sums('Room 206', room206, 3000)

t('exactly the debt leaves no remainder',
  splitRepaymentByCredit([chidera, prosper], 2500, 'daniel'), 'prosper:1000 chidera:1500')

t('part payment clears the oldest credit first',
  splitRepaymentByCredit([chidera, prosper], 600, 'daniel'), 'prosper:600')

t('part payment spilling into the second person',
  splitRepaymentByCredit([chidera, prosper], 1200, 'daniel'), 'prosper:1000 chidera:200')

t('one person owed, paid short',
  splitRepaymentByCredit([chidera], 500, 'daniel'), 'chidera:500')

// Nobody owed anything at that department. The money still has to be
// recorded, and with no slice to point at it falls to the desk - the old
// behaviour, kept only for the case where there is nothing better.
t('no debt at all falls back to the desk',
  splitRepaymentByCredit([], 2200, 'desk'), 'desk:2200')

t('only cleared slices falls back to the desk',
  splitRepaymentByCredit([{ staffId: 'kate', balance: 0, firstCreditDate: '2026-10-06' }], 450, 'desk'),
  'desk:450')

// A slice already in the red is not a debt: it must never absorb a
// payment, or the fault repeats itself one person along.
t('a negative slice is never paid into',
  splitRepaymentByCredit([{ staffId: 'daniel', balance: -3000, firstCreditDate: '2026-10-18' }, chidera], 1500, 'desk'),
  'chidera:1500')

t('overpayment goes to the most recent server, not the desk',
  splitRepaymentByCredit(
    [{ staffId: 'old', balance: 100, firstCreditDate: '2026-09-01', lastCreditDate: '2026-09-02' },
     { staffId: 'new', balance: 100, firstCreditDate: '2026-10-01', lastCreditDate: '2026-11-08' }],
    1000, 'desk'),
  'old:100 new:900')

t('a slice with no date sorts last, never ahead of a known one',
  splitRepaymentByCredit(
    [{ staffId: 'undated', balance: 500, firstCreditDate: null, lastCreditDate: null }, prosper],
    1200, 'desk'),
  'prosper:1000 undated:200')

t('nothing taken writes nothing', splitRepaymentByCredit([chidera], 0, 'desk'), '')
t('a negative amount writes nothing', splitRepaymentByCredit([chidera], -50, 'desk'), '')
t('no slices and nothing taken writes nothing', splitRepaymentByCredit([], 0, 'desk'), '')

// Kobo. The parts must still add to the amount taken.
const kobo = splitRepaymentByCredit(
  [{ staffId: 'a', balance: 33.33, firstCreditDate: '2026-10-01' },
   { staffId: 'b', balance: 33.33, firstCreditDate: '2026-10-02' },
   { staffId: 'c', balance: 33.34, firstCreditDate: '2026-10-03' }], 100, 'desk')
t('kobo split across three', kobo, 'a:33.33 b:33.33 c:33.34')
sums('kobo split', kobo, 100)

// One person must never get two rows, however the money reaches them.
const once = splitRepaymentByCredit([prosper], 5000, 'desk')
t('a single person gets a single row', once, 'prosper:5000')
sums('single row', once, 5000)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
