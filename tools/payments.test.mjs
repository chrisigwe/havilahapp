// A payment sheet must never save a number different from the one the
// person typed. Before 12 November 2026 a split only had to add up to
// something, so N3,000 split 1,000/500 saved N1,500 in silence.
import { paymentParts, paymentAllocated, paymentReady } from '../src/lib/payments.js'

let pass = 0, fail = 0
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) pass++
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)) }
}

const single = m => ({ method: m, split: null })
const split = (pos, cash) => ({ method: 'pos', split: { pos, cash } })

// ── what gets written ───────────────────────────────────────────────
ok('single method writes one row', paymentParts(single('cash'), '3000'),
   [{ method: 'cash', amount: 3000 }])
ok('split writes one row per method', paymentParts(split('2000', '1000'), '3000'),
   [{ method: 'pos', amount: 2000 }, { method: 'cash', amount: 1000 }])
ok('blank side of a split is zero', paymentParts(split('3000', ''), '3000'),
   [{ method: 'pos', amount: 3000 }, { method: 'cash', amount: 0 }])
ok('allocated is the sum of the rows', paymentAllocated(split('2000', '1000'), '3000'), 3000)
ok('allocated ignores the typed total when split', paymentAllocated(split('1000', '500'), '3000'), 1500)

// ── what may be saved ───────────────────────────────────────────────
ok('a method and an amount is ready', paymentReady(single('pos'), '3000'), true)
ok('no method is not ready', paymentReady({ method: null, split: null }, '3000'), false)
ok('no amount is not ready', paymentReady(single('pos'), ''), false)
ok('zero is not ready', paymentReady(single('pos'), '0'), false)
ok('negative is not ready', paymentReady(single('pos'), '-500'), false)

ok('split that adds up is ready', paymentReady(split('2000', '1000'), '3000'), true)
ok('short split is refused', paymentReady(split('1000', '500'), '3000'), false)
ok('over split is refused', paymentReady(split('2000', '2000'), '3000'), false)
ok('empty split is refused', paymentReady(split('', ''), '3000'), false)
ok('one-sided split that adds up is ready', paymentReady(split('3000', ''), '3000'), true)
ok('split with no amount typed is refused', paymentReady(split('1000', '2000'), ''), false)

// kobo: a split may land on the amount to within a kobo, not a naira
ok('a kobo under is allowed', paymentReady(split('1999.995', '1000'), '2999.995'), true)
ok('ten kobo under is refused', paymentReady(split('1999.90', '1000'), '3000'), false)
ok('ten kobo over is refused', paymentReady(split('2000.10', '1000'), '3000'), false)

// a three-way split, in case a method is ever added
ok('three-way split that adds up is ready',
   paymentReady({ method: 'pos', split: { pos: '1000', cash: '1000', transfer: '1000' } }, '3000'), true)
ok('three-way split that does not is refused',
   paymentReady({ method: 'pos', split: { pos: '1000', cash: '1000', transfer: '900' } }, '3000'), false)

// the old behaviour, named so it cannot come back unnoticed
ok('the N3,000 that saved N1,500 is now refused', paymentReady(split('1000', '500'), '3000'), false)

console.log(`payments: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
