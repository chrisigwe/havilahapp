import { ageByMonth, undatedRows } from '../src/lib/aging.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} -> ${got}`) }
  else { fail++; console.log(`  FAIL ${name}: got "${got}", want "${want}"`) }
}

const sale = (o) => ({
  sale_id: o.id, customer_id: o.who, customer: o.name || o.who,
  taken_on: o.on, amount: o.amt, still_owed: o.owed ?? 0,
  location_id: o.at || 'bar', item: 'Beer', qty: 1, staff: 'Ikenna',
})

const rows = [
  sale({ id: 1, who: 'c1', name: 'Mayor',  on: '2026-09-04', amt: 5000, owed: 5000 }),
  sale({ id: 2, who: 'c1', name: 'Mayor',  on: '2026-09-20', amt: 3000, owed: 0 }),
  sale({ id: 3, who: 'c2', name: 'Dagama', on: '2026-09-04', amt: 1000, owed: 1000 }),
  sale({ id: 4, who: 'c2', name: 'Dagama', on: '2026-10-11', amt: 9000, owed: 0 }),
  sale({ id: 5, who: 'c3', name: 'Ella',   on: '2026-10-11', amt: 2000, owed: 400, at: 'mart' }),
  sale({ id: 6, who: 'c1', name: 'Mayor',  on: '2025-12-31', amt: 700,  owed: 700 }),
]

const all = ageByMonth(rows, 'all')
eq('years come back newest first', all.map(y => y.key).join(','), '2026,2025')
eq('months come back newest first',
   all[0].months.map(m => m.key).join(','), '2026-10,2026-09')
//
// The figures. September gave 9,000 and 6,000 of it has never been paid
// for; October gave 11,000 and only Ella's 400 is outstanding.
eq('a month totals what it gave', all[0].months[1].given, 9000)
eq('a month totals what it still owes', all[0].months[1].owed, 6000)
eq('a settled month knows it', all[0].months[0].owed, 400)
eq('the year adds its months up', all[0].given, 20000)
//
// Biggest debt first inside a month, which is the chasing order.
eq('people inside a month, biggest debt first',
   all[0].months[1].people.map(p => p.name).join(','), 'Mayor,Dagama')
eq("a person's month total is theirs alone", all[0].months[1].people[0].owed, 5000)
eq('a person keeps every item of that month',
   all[0].months[1].people[0].rows.length, 2)
//
// A person who settled stays in the month. The month's job is to show
// what it gave as well as what it is owed, and an account that vanishes
// when it pays is how Mr Michael's debt became invisible.
eq('someone who paid up is still listed',
   all[0].months[0].people.map(p => `${p.name}:${p.owed}`).join(','),
   'Ella:400,Dagama:0')
//
// Department scoping, the same filter the rest of the page applies.
const mart = ageByMonth(rows, 'mart')
eq('one department sees only its own', mart[0].months.length, 1)
eq('and only its own money', mart[0].months[0].given, 2000)
eq('no department filter means every department',
   ageByMonth(rows, null)[0].months[1].given, 9000)
//
// A row with no date cannot be placed. It must not be silently counted
// into a month it does not belong to, and the page has to be able to
// say it exists.
const withUndated = [...rows, sale({ id: 7, who: 'c9', name: 'Ghost', on: null, amt: 500, owed: 500 })]
eq('an undated row is not forced into a month',
   ageByMonth(withUndated, 'all')[0].given, 20000)
eq('but it can be found and reported', undatedRows(withUndated, 'all').length, 1)
eq('nothing at all gives nothing back', ageByMonth([], 'all').length, 0)
eq('undefined rows do not throw', ageByMonth(undefined, 'all').length, 0)

console.log(`\naging: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
