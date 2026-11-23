// The supply line's sentences are arithmetic in words. The Store Manager
// issues or refuses on them, so they must never say something the number
// beside them contradicts.
import { supplyStory, supplyShortfall, sinceText } from '../src/lib/supplytext.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const f = (received, used, returned = 0) => ({ received, used, returned })

eq('the ordinary line', supplyStory(f(48, 31), 17), 'Store gave 48. 31 recorded used.')
eq('nothing used yet', supplyStory(f(5, 0), 5), 'Store gave 5. None recorded used.')
eq('never issued anything', supplyStory(f(0, 0), 0),
   'The Store has never given any. None recorded used.')
eq('something went back', supplyStory(f(48, 31, 2), 15),
   'Store gave 48. 31 recorded used. 2 sent back.')

// The lighters: 5 given, none used, then 2 taken off by a stock count.
eq('a correction that removed stock', supplyStory(f(5, 0), 3),
   'Store gave 5. None recorded used. 2 taken off by a correction.')
eq('a correction that added stock', supplyStory(f(5, 0), 7),
   'Store gave 5. None recorded used. 2 added by a correction.')

// The rule the whole thing rests on: whatever the balance is, the
// sentence accounts for it exactly.
for (const [got, used, back, have] of [[48,31,0,17],[48,31,2,15],[5,0,0,3],[0,0,0,-4],[60,44,0,16],[7,2,1,9]]) {
  const s = supplyStory(f(got, used, back), have)
  const stated = (got - used - back)
    + (/(\d+) added by a correction/.exec(s) ? Number(/(\d+) added by a correction/.exec(s)[1]) : 0)
    - (/(\d+) taken off by a correction/.exec(s) ? Number(/(\d+) taken off by a correction/.exec(s)[1]) : 0)
  eq(`the sentence accounts for a balance of ${have}`, stated, have)
}

eq('a shortfall is said as a complaint', supplyShortfall(-8),
   '8 more recorded used than the Store ever gave.')

eq('today', sinceText('2026-11-23', '2026-11-23'), 'Last recorded today.')
eq('yesterday', sinceText('2026-11-22', '2026-11-23'), 'Last recorded 22 Nov, 1 day ago.')
eq('six weeks', sinceText('2026-10-11', '2026-11-23'), 'Last recorded 11 Oct, 43 days ago.')
eq('no date at all', sinceText(null, '2026-11-23'), null)
// A date in the future cannot read as "-1 days ago".
eq('a date ahead of today', sinceText('2026-11-24', '2026-11-23'), 'Last recorded today.')

console.log(`\nsupplytext: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
