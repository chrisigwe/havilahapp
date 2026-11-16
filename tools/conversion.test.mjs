// A conversion must take stock off one shelf and put it on the same
// one, never the other way round. A reversed leg moves stock in the
// wrong direction silently, and nobody finds out until a count.
import { conversionRows } from '../src/lib/conversion.js'

let pass = 0, fail = 0
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const refuses = (name, fn) => {
  try { fn(); fail++; console.log(`  FAIL ${name} — it was allowed`) }
  catch { pass++; console.log(`  ok   ${name}`) }
}

const staff = { id: 'staff-1', branch_id: 'branch-1' }
const bottle = { id: 'item-bottle', name: 'St Remy' }
const shot   = { id: 'item-shot',   name: 'St Remy (Shot)' }
const BAR    = 'loc-openbar'
const DAY    = '2026-11-16'

const base = { staff, fromItem: bottle, fromQty: 1, toItem: shot, toQty: 20,
               locationId: BAR, date: DAY }
const rows = conversionRows(base)

ok('two legs, never one or three', rows.length, 2)

ok('the first leg leaves', [rows[0].from_location, rows[0].to_location], [BAR, null])
ok('the second leg arrives', [rows[1].from_location, rows[1].to_location], [null, BAR])

ok('the bottle is what leaves', [rows[0].stock_item_id, rows[0].qty], ['item-bottle', 1])
ok('the shots are what arrive', [rows[1].stock_item_id, rows[1].qty], ['item-shot', 20])

ok('both legs are a conversion',
   rows.map(r => r.movement_type), ['conversion', 'conversion'])
ok('both legs sit on the same day', rows.map(r => r.business_date), [DAY, DAY])
ok('both legs carry the same instant', rows[0].occurred_at, rows[1].occurred_at)
ok('both legs name the same person', rows.map(r => r.recorded_by), ['staff-1', 'staff-1'])
ok('both legs name the same branch', rows.map(r => r.branch_id), ['branch-1', 'branch-1'])
ok('neither leg is a migration', rows.map(r => r.is_migrated), [false, false])

ok('the note says what happened, both sides',
   [rows[0].note, rows[1].note],
   ['Converted 1 × St Remy into 20 × St Remy (Shot)',
    'Converted 1 × St Remy into 20 × St Remy (Shot)'])

ok('a given note is used instead',
   conversionRows({ ...base, note: 'Opened a bottle' })[0].note, 'Opened a bottle')

// A part-poured bottle yields what is left in it, not a full one.
ok('a part bottle converts to what is left',
   conversionRows({ ...base, toQty: 8 })[1].qty, 8)

// Quantities arriving as text from an input box must still be numbers.
ok('a typed quantity becomes a number',
   conversionRows({ ...base, toQty: '20' })[1].qty, 20)

refuses('an item converting into itself',
  () => conversionRows({ ...base, toItem: bottle }))
refuses('nothing leaving', () => conversionRows({ ...base, fromQty: 0 }))
refuses('nothing arriving', () => conversionRows({ ...base, toQty: 0 }))
refuses('a negative quantity', () => conversionRows({ ...base, toQty: -5 }))
refuses('a quantity that is not a number', () => conversionRows({ ...base, toQty: 'plenty' }))
refuses('no place to do it in', () => conversionRows({ ...base, locationId: null }))
refuses('no day to put it on', () => conversionRows({ ...base, date: null }))
refuses('nobody recording it', () => conversionRows({ ...base, staff: {} }))

console.log(`\nconversion: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
