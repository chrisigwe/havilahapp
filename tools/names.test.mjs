// Names are written down one way, whoever types them.
import { tidyName } from '../src/lib/names.js'

let pass = 0, fail = 0
const ok = (input, want) => {
  const got = tidyName(input)
  if (got === want) { pass++; console.log(`  ok   ${JSON.stringify(input)} -> ${JSON.stringify(got)}`) }
  else { fail++; console.log(`  FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`) }
}

// the shouting and the whispering, from the live data
ok('FRANK', 'Frank')
ok('ikenna', 'Ikenna')
ok('Mr Chimezie', 'Mr Chimezie')
ok('EBUKA', 'Ebuka')
ok('ejike samuel', 'Ejike Samuel')
ok('CHUKWUDI', 'Chukwudi')

// spacing and empties
ok('  Mr   Frank  ', 'Mr Frank')
ok('', '')
ok('   ', '')
ok(null, '')
ok(undefined, '')

// capitals that are meant
ok('HRH Igwe', 'HRH Igwe')
ok('hrh igwe', 'HRH Igwe')
ok('PSN', 'PSN')
ok('GM', 'GM')
ok('gm', 'GM')
ok('Chukwuemeka II', 'Chukwuemeka II')

// names that carry their own capitals
ok("o'neill", "O'Neill")
ok('mcdonald', 'McDonald')
ok('MACAULAY', 'Macaulay')   // Mac is left alone on purpose
ok('chukwuemeka-obi', 'Chukwuemeka-Obi')
ok('MARY-JANE', 'Mary-Jane')

// brackets are left alone — a room number or a job, never guessed at
ok('mr obitex (Room 207)', 'Mr Obitex (Room 207)')
ok('chidera (staff)', 'Chidera (staff)')
ok('UGO (gateman)', 'Ugo (gateman)')

// a tombstone is a marker, not a name
ok('[merged into Mr Onyeka] Mr Onyeka', '[merged into Mr Onyeka] Mr Onyeka')
ok('[merged into GM, 2] General manager', '[merged into GM, 2] General manager')

// digits survive
ok('as1man greg', 'As1man Greg')

console.log(`\nnames: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
