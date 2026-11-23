// A refused write is shown to the person who made it so they can key it
// again. These sentences are what they key it from.
import { describeJob, refusalReason } from '../src/lib/outboxtext.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

const line = (name, qty, unitPrice) => ({ item: { id: 'x', name }, qty, unitPrice })

eq('a one-item sale names the item',
  describeJob({ kind: 'basket', payload: { date: '2026-11-21', lines: [line('Star', 2, 1300)] } }),
  'Sale of ₦2,600 — Star, 21 Nov')
eq('a bigger sale names the first and counts the rest',
  describeJob({ kind: 'basket', payload: { date: '2026-11-21',
    lines: [line('Star', 2, 1300), line('Coke', 1, 800), line('Water', 3, 500)] } }),
  'Sale of ₦4,900 — Star and 2 other items, 21 Nov')
eq('one other item is singular',
  describeJob({ kind: 'basket', payload: { date: '2026-11-21', lines: [line('Star', 1, 1300), line('Coke', 1, 800)] } }),
  'Sale of ₦2,100 — Star and 1 other item, 21 Nov')
eq('a typed description stands in for an item',
  describeJob({ kind: 'basket', payload: { date: '2026-11-21',
    lines: [{ description: 'Nsala and semo', qty: 1, unitPrice: 9000 }] } }),
  'Sale of ₦9,000 — Nsala and semo, 21 Nov')
eq('a sale with no date still says what it was',
  describeJob({ kind: 'basket', payload: { lines: [line('Star', 1, 1300)] } }),
  'Sale of ₦1,300 — Star')

eq('a repayment', describeJob({ kind: 'repayment', payload: { amount: 40000, paidOn: '2026-11-20' } }),
  'Payment of ₦40,000, 20 Nov')
eq('a damage write-off',
  describeJob({ kind: 'writeoff', payload: { qty: 3, itemName: 'Lighter (For Sale)', kind: 'damage', date: '2026-09-15' } }),
  '3 × Lighter (For Sale) recorded as damaged, 15 Sept')  // en-NG abbreviates September with four letters
eq('a complimentary write-off without a name',
  describeJob({ kind: 'writeoff', payload: { qty: 2, kind: 'complimentary', date: '2026-07-14' } }),
  '2 × an item recorded as given free, 14 Jul')
eq('stock movements',
  describeJob({ kind: 'movements', payload: { rows: [{ business_date: '2026-11-23' }, {}] } }),
  '2 stock movements, 23 Nov')
eq('one movement is singular',
  describeJob({ kind: 'movements', payload: { rows: [{ business_date: '2026-11-23' }] } }),
  '1 stock movement, 23 Nov')
eq('a count line', describeJob({ kind: 'countLine', payload: { qty: 11 } }), 'A stock count entry of 11')

// A job queued by a newer version and flushed by an older one used to be
// dropped without a word. It must still say something.
eq('an unknown kind', describeJob({ kind: 'somethingNew', payload: {} }),
  'An entry this version of the app does not recognise')
eq('a job with nothing in it does not throw', describeJob(null),
  'An entry this version of the app does not recognise')
eq('a sale with no lines at all',
  describeJob({ kind: 'basket', payload: { lines: [] } }), 'Sale of ₦0 — 0 items')

eq('the server sentence is kept', refusalReason('That day is closed. It has to go to the GM.'),
  'That day is closed. It has to go to the GM.')
eq('silence is reported as silence', refusalReason(''), 'The server refused it and gave no reason.')

console.log(`\noutboxtext: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
