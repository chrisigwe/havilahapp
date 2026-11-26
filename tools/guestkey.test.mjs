// guests.name_key is a GENERATED column: normalize_customer_name(full_name).
// The app has to be able to compute the same key, or it looks for a guest
// who is sitting right there, fails to find them, inserts a second row and
// the unique index refuses it — which is exactly what reached a front-desk
// screen on 26 November 2026 while booking Chinemelum Okoli:
//
//   duplicate key value violates unique constraint "guests_branch_name_key_uniq"
//
// The cause was a SECOND normaliser in format.js whose comment claimed it
// mirrored the database. It stripped every space, so "chinemelum okoli"
// became "chinemelumokoli" and matched nothing. It is gone.
//
// Every pair below was read out of the live database — full_name on the
// left, the name_key Postgres generated on the right. If this file ever
// fails, the app and the database have drifted and bookings will start
// failing on names that already exist.
import { normalizeCustomerName } from '../src/lib/customerName.js'

let pass = 0, fail = 0
const eq = (name, key) => {
  const got = normalizeCustomerName(name)
  if (got === key) { pass++; console.log(`  ok   ${JSON.stringify(name)} -> ${JSON.stringify(got)}`) }
  else { fail++; console.log(`  FAIL ${JSON.stringify(name)}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(key)}`) }
}

// Nnewi guests, 26 November 2026.
eq('chinemelum okoli', 'chinemelum okoli')
eq('Chinemerum Okoli', 'chinemerum okoli')
eq('chinaemerum okoli', 'chinaemerum okoli')
eq('chibuike okoli', 'chibuike okoli')
eq('chukwuebuka okoli', 'chukwuebuka okoli')
eq('somto okoli', 'somto okoli')
eq('nwala chineme', 'nwala chineme')
eq('WISDOM CHINEME', 'wisdom chineme')
eq('CHINEMEREM GABRIEL', 'chinemerem gabriel')
eq('OKOLI HENRY', 'okoli henry')

// A merged record keeps its bracketed marker in the name, and the key
// keeps it too — square brackets are not parentheses.
eq('[merged into chukwuebuka okoli] Chukwuebuka',
   'merged into chukwuebuka okoli chukwuebuka')

// Awka, 25 November 2026: the parenthetical IS dropped.
eq('Nnamdi Azikiwe University (UNIZIK)', 'nnamdi azikiwe university')

// The space is the whole point. A normaliser that strips it turns two
// words into one and finds nobody.
if (normalizeCustomerName('chinemelum okoli').includes(' ')) {
  pass++; console.log('  ok   the key keeps the space between words')
} else {
  fail++; console.log('  FAIL the key dropped the space — lookups will miss')
}

console.log(`\nguestkey: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
