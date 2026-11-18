import { splitRepaymentByCredit, applyMethods } from '../src/lib/creditsplit.js'

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

// ── The same person owed at two departments ──────────────────────────
// Credit calls this with everything a customer owes, not one
// department's worth, so one person can appear twice and the two slices
// must stay apart: a repayment is written against a department as well
// as a person (18 November 2026).
const show2 = (parts) => parts
  .map(p => `${p.staffId}@${p.locationId ?? '-'}:${p.amount}`).join(' ')
const t2 = (name, got, want) => {
  const g = show2(got)
  if (g === want) { pass++; console.log(`  ok   ${name} -> ${g || '(nothing)'}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${g}", want "${want}"`) }
}

const twoDepts = [
  { staffId: 'ikenna', locationId: 'openbar', balance: 6000, firstCreditDate: '2026-09-04', lastCreditDate: '2026-10-20' },
  { staffId: 'joseph', locationId: 'mainbar', balance: 4000, firstCreditDate: '2026-10-11', lastCreditDate: '2026-11-02' },
]
const whole = splitRepaymentByCredit(twoDepts, 10000, 'desk')
t2('paying everything clears both', whole, 'ikenna@openbar:6000 joseph@mainbar:4000')
sums('both departments', whole, 10000)

const partial = splitRepaymentByCredit(twoDepts, 7500, 'desk')
t2('a part payment takes the older debt first', partial,
   'ikenna@openbar:6000 joseph@mainbar:1500')
sums('older first across departments', partial, 7500)

const short = splitRepaymentByCredit(twoDepts, 2000, 'desk')
t2('less than the oldest debt never reaches the newer', short, 'ikenna@openbar:2000')
sums('short payment', short, 2000)

// The merging fault this guards: same person, two counters.
const samePerson = [
  { staffId: 'prosper', locationId: 'mainbar', balance: 3000, firstCreditDate: '2026-09-01', lastCreditDate: '2026-09-01' },
  { staffId: 'prosper', locationId: 'minimart', balance: 2000, firstCreditDate: '2026-10-01', lastCreditDate: '2026-10-01' },
]
const kept = splitRepaymentByCredit(samePerson, 5000, 'desk')
t2('one person at two departments stays two rows', kept,
   'prosper@mainbar:3000 prosper@minimart:2000')
sums('same person, two counters', kept, 5000)

// ...but at ONE department they still merge, exactly as before.
const sameDept = [
  { staffId: 'prosper', locationId: 'mainbar', balance: 3000, firstCreditDate: '2026-09-01' },
  { staffId: 'prosper', locationId: 'mainbar', balance: 2000, firstCreditDate: '2026-10-01' },
]
const merged = splitRepaymentByCredit(sameDept, 5000, 'desk')
t2('one person at one department is still one row', merged, 'prosper@mainbar:5000')
sums('same person, same counter', merged, 5000)

// Overpayment follows the person served most recently, and keeps their
// department with it — never landing on a counter they owe nothing at.
const over = splitRepaymentByCredit(twoDepts, 12000, 'desk')
t2('an overpayment goes to whoever served them last', over,
   'ikenna@openbar:6000 joseph@mainbar:6000')
sums('overpayment across departments', over, 12000)

// A caller that supplies no department is unchanged: null, not undefined,
// so the shape is the same whichever way it is called.
const noDept = splitRepaymentByCredit(
  [{ staffId: 'chidera', balance: 1500, firstCreditDate: '2026-10-01' }], 1500, 'desk')
t2('no department given means a null department', noDept, 'chidera@-:1500')

// ── Whose debt AND by what method ────────────────────────────────────
const show3 = (parts) => parts
  .map(p => `${p.staffId}@${p.locationId ?? '-'}/${p.method}:${p.amount}`).join(' ')
const t3 = (name, got, want) => {
  const g = show3(got)
  if (g === want) { pass++; console.log(`  ok   ${name} -> ${g || '(nothing)'}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${g}", want "${want}"`) }
}
const debts = [
  { staffId: 'ikenna', locationId: 'openbar', amount: 6000 },
  { staffId: 'joseph', locationId: 'mainbar', amount: 4000 },
]

t3('one method leaves the debts alone',
   applyMethods(debts, [{ method: 'cash', amount: 10000 }]),
   'ikenna@openbar/cash:6000 joseph@mainbar/cash:4000')

// The cash covers the older debt and part of the newer; the POS
// finishes it. Four facts, three rows.
t3('a method split cuts across the debts',
   applyMethods(debts, [{ method: 'cash', amount: 7000 }, { method: 'pos', amount: 3000 }]),
   'ikenna@openbar/cash:6000 joseph@mainbar/cash:1000 joseph@mainbar/pos:3000')

t3('a method boundary that lands exactly on a debt boundary',
   applyMethods(debts, [{ method: 'cash', amount: 6000 }, { method: 'pos', amount: 4000 }]),
   'ikenna@openbar/cash:6000 joseph@mainbar/pos:4000')

t3('three methods across two debts',
   applyMethods(debts, [{ method: 'cash', amount: 2000 },
                        { method: 'pos', amount: 5000 },
                        { method: 'transfer', amount: 3000 }]),
   'ikenna@openbar/cash:2000 ikenna@openbar/pos:4000 '
   + 'joseph@mainbar/pos:1000 joseph@mainbar/transfer:3000')

sums('method split across debts',
     applyMethods(debts, [{ method: 'cash', amount: 7000 }, { method: 'pos', amount: 3000 }]), 10000)
sums('three methods', applyMethods(debts, [{ method: 'cash', amount: 2000 },
     { method: 'pos', amount: 5000 }, { method: 'transfer', amount: 3000 }]), 10000)

// A zero-amount method must not spin the walk forever.
t3('an empty method part is skipped',
   applyMethods(debts, [{ method: 'cash', amount: 0 }, { method: 'pos', amount: 10000 }]),
   'ikenna@openbar/pos:6000 joseph@mainbar/pos:4000')
t3('nothing in, nothing out', applyMethods([], [{ method: 'cash', amount: 100 }]), '')
t3('no methods, nothing out', applyMethods(debts, []), '')

// End to end: the split rule feeding the method rule, which is how the
// Credit page uses the pair.
const slices = [
  { staffId: 'ikenna', locationId: 'openbar', balance: 6000, firstCreditDate: '2026-09-04' },
  { staffId: 'joseph', locationId: 'mainbar', balance: 4000, firstCreditDate: '2026-10-11' },
]
const endToEnd = applyMethods(
  splitRepaymentByCredit(slices, 5000, 'desk'),
  [{ method: 'cash', amount: 3000 }, { method: 'pos', amount: 2000 }])
t3('a part payment, part cash part POS', endToEnd,
   'ikenna@openbar/cash:3000 ikenna@openbar/pos:2000')
sums('end to end', endToEnd, 5000)

// Named debts keep their sale through a method split, so a payment that
// is part cash part POS still says which debt each part cleared.
const named = applyMethods(
  [{ staffId: 'ikenna', locationId: 'openbar', saleId: 's1', amount: 2600 },
   { staffId: 'ikenna', locationId: 'openbar', saleId: 's2', amount: 600 }],
  [{ method: 'cash', amount: 3000 }, { method: 'pos', amount: 200 }])
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} -> ${got}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${got}", want "${want}"`) }
}
eq('a split payment still names each debt',
   named.map(p => `${p.saleId}/${p.method}:${p.amount}`).join(' '),
   's1/cash:2600 s2/cash:400 s2/pos:200')
sums('named debts across methods', named, 3200)
eq('no sale means a null sale, not undefined',
   applyMethods([{ staffId: 'a', amount: 100 }], [{ method: 'cash', amount: 100 }])
     .map(p => String(p.saleId)).join(''), 'null')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
