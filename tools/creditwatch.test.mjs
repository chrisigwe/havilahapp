// The briefing must name everybody the bar needs warning about, and
// nobody else. A name missing from it is a drink poured on credit that
// should not have been.
import { creditWatch, creditWatchLine } from '../src/lib/creditwatch.js'

let pass = 0, fail = 0
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const names = rows => rows.map(r => r.name)

const customers = [
  { id: 'a', name: 'Mr Chike Ifeadi', phone: '0801', no_more_credit: true },
  { id: 'b', name: 'Mr Obitex',       phone: '0802', no_more_credit: true },
  { id: 'c', name: 'Engr Iyke',       phone: '0803' },
  { id: 'd', name: 'Mr Alphonso',     phone: '0804' },
  { id: 'e', name: 'Mayor',           phone: null },
  { id: 'f', name: 'Oga Obi',         phone: '0806' },
]
const owed = { a: 261700, b: 75500, c: 2200, d: 60000, e: 50000, f: 0 }
const LIMIT = 50000

const rows = creditWatch({ customers, owed, limit: LIMIT })

ok('cut off first, then biggest debt down',
   names(rows), ['Mr Chike Ifeadi', 'Mr Obitex', 'Mr Alphonso'])

ok('exactly at the limit is not over it',
   names(creditWatch({ customers: [{ id: 'e', name: 'Mayor' }], owed, limit: LIMIT })), [])
ok('a naira over the limit is over it',
   names(creditWatch({ customers: [{ id: 'e', name: 'Mayor' }], owed: { e: 50001 }, limit: LIMIT })),
   ['Mayor'])

ok('somebody under the limit is left alone',
   names(creditWatch({ customers: [{ id: 'c', name: 'Engr Iyke' }], owed, limit: LIMIT })), [])

// A cut-off customer who has paid everything off still gets listed: the
// instruction is about the person, not the balance.
ok('cut off and owing nothing is still listed',
   names(creditWatch({ customers: [{ id: 'f', name: 'Oga Obi', no_more_credit: true }], owed, limit: LIMIT })),
   ['Oga Obi'])

ok('the owed figure is carried through', creditWatch({ customers, owed, limit: LIMIT })[0].owed, 261700)
ok('a missing balance reads as nothing owed',
   creditWatch({ customers: [{ id: 'zz', name: 'New', no_more_credit: true }], owed, limit: LIMIT })[0].owed, 0)

// No limit set on a branch must not silently list everybody, nor hide a
// cut-off customer.
ok('no limit lists only the cut off',
   names(creditWatch({ customers, owed, limit: null })), ['Mr Chike Ifeadi', 'Mr Obitex'])
ok('a zero limit is treated as no limit, not as everyone over',
   names(creditWatch({ customers, owed, limit: 0 })), ['Mr Chike Ifeadi', 'Mr Obitex'])

ok('no customers gives nothing', creditWatch({ customers: [], owed, limit: LIMIT }), [])
ok('null customers gives nothing', creditWatch({ customers: null, owed, limit: LIMIT }), [])
ok('null balances give nothing but the cut off',
   names(creditWatch({ customers, owed: null, limit: LIMIT })), ['Mr Chike Ifeadi', 'Mr Obitex'])

// Same flag, same debt — name decides, so the list does not reshuffle
// between loads.
ok('a tie is broken by name', names(creditWatch({
     customers: [{ id: 'x', name: 'Zubby' }, { id: 'y', name: 'Amaka' }],
     owed: { x: 90000, y: 90000 }, limit: LIMIT })), ['Amaka', 'Zubby'])

ok('the line names both kinds', creditWatchLine(rows), '2 on no credit, 1 past the limit')
ok('the line drops a kind with nobody in it',
   creditWatchLine(creditWatch({ customers: [{ id: 'd', name: 'Mr Alphonso' }], owed, limit: LIMIT })),
   '1 past the limit')
ok('nothing to say says nothing', creditWatchLine([]), null)
ok('null says nothing', creditWatchLine(null), null)

console.log(`\ncreditwatch: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
