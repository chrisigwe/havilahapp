// Tapping POS and Cash, and what each one is worth. The picker's chips
// decide how much of a payment lands on each method, so the rule lives
// in payments.js and is proved here rather than read off a component.
import { toggleMethod, setSplitAmount, paymentParts, paymentReady } from '../src/lib/payments.js'

let pass = 0, fail = 0
const show = v => v.split
  ? Object.entries(v.split).map(([m, a]) => `${m}:${a === '' ? '-' : a}`).join(' ')
  : (v.method ? `${v.method} (all)` : '(none)')
const t = (name, got, want) => {
  const g = show(got)
  if (g === want) { pass++; console.log(`  ok   ${name} -> ${g}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${g}", want "${want}"`) }
}

const none = { method: null, split: null }

// One tap is the whole payment.
const pos = toggleMethod(none, 'pos', 5000)
t('tapping POS takes the whole payment', pos, 'pos (all)')

// A second tap is a split, and the first keeps the remainder.
const both = toggleMethod(pos, 'cash', 5000)
t('tapping Cash as well makes it a split', both, 'pos:5000 cash:-')

// Typing cash moves the rest onto POS without anyone doing subtraction.
const typed = setSplitAmount(both, 'cash', '2000', 5000)
t('entering the Cash amount leaves POS the rest', typed, 'pos:3000 cash:2000')
t('and it adds up', { split: { x: paymentParts(typed, 5000).reduce((s, p) => s + p.amount, 0) } }, 'x:5000')

// Typing POS instead moves the rest onto Cash.
t('entering the POS amount leaves Cash the rest',
  setSplitAmount(typed, 'pos', '1500', 5000), 'pos:1500 cash:3500')

// Over the amount: the other side floors at zero rather than going negative.
t('more than the payment never makes the other side negative',
  setSplitAmount(both, 'cash', '9000', 5000), 'pos:0 cash:9000')

// Untapping.
t('untapping Cash leaves POS with the lot', toggleMethod(typed, 'cash', 5000), 'pos (all)')
t('untapping the only method leaves nothing', toggleMethod(pos, 'pos', 5000), '(none)')

// Kobo.
const kobo = setSplitAmount(toggleMethod(toggleMethod(none, 'pos', 100.5), 'cash', 100.5), 'cash', '33.33', 100.5)
t('kobo', kobo, 'pos:67.17 cash:33.33')

// A split that adds up is ready; one that does not is not.
const ok = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`) }
}
ok('a balanced split can be saved', paymentReady(typed, 5000), true)
ok('an unbalanced split cannot', paymentReady(setSplitAmount(both, 'cash', '2000', 9999), 5000), false)
ok('one method can be saved', paymentReady(pos, 5000), true)
ok('no method cannot', paymentReady(none, 5000), false)

console.log(`\nmethodpick: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
