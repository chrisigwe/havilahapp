// A folded list must hold everybody it was given.
import { monthBuckets, monthLabel, UNDATED } from '../src/lib/months.js'

let pass = 0, fail = 0
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const d = x => x.since
const shape = bs => bs.map(b => [b.key, b.rows.map(r => r.n)])

const people = [
  { n: 'ngozi',  since: '2026-11-04' },
  { n: 'michael',since: '2026-10-06' },
  { n: 'obi',    since: '2026-09-08' },
  { n: 'alpho',  since: '2026-10-02' },
  { n: 'nameless', since: null },
]

ok('newest month first, undated last', shape(monthBuckets(people, d)),
   [['2026-11', ['ngozi']], ['2026-10', ['michael', 'alpho']], ['2026-09', ['obi']], [UNDATED, ['nameless']]])

ok('nobody is dropped',
   monthBuckets(people, d).reduce((t, b) => t + b.rows.length, 0), people.length)

ok('order within a month is the order given', shape(monthBuckets(
   [{ n: 'b', since: '2026-10-30' }, { n: 'a', since: '2026-10-01' }], d)),
   [['2026-10', ['b', 'a']]])

ok('empty list gives no groups', monthBuckets([], d), [])
ok('null list gives no groups', monthBuckets(null, d), [])
ok('every row undated gives one group', shape(monthBuckets(
   [{ n: 'x', since: null }, { n: 'y', since: undefined }, { n: 'z', since: '' }], d)),
   [[UNDATED, ['x', 'y', 'z']]])
ok('a year boundary sorts correctly', shape(monthBuckets(
   [{ n: 'dec', since: '2025-12-31' }, { n: 'jan', since: '2026-01-01' }], d)),
   [['2026-01', ['jan']], ['2025-12', ['dec']]])
ok('a short or malformed date counts as undated', shape(monthBuckets(
   [{ n: 'bad', since: '2026' }], d)), [[UNDATED, ['bad']]])
ok('a full timestamp still buckets by month', shape(monthBuckets(
   [{ n: 't', since: '2026-08-14T09:30:00Z' }], d)), [['2026-08', ['t']]])

ok('label reads as a person would say it', monthLabel('2026-11'), 'November 2026')
ok('undated says so', monthLabel(UNDATED), 'No date recorded')
ok('December does not slide into January', monthLabel('2025-12'), 'December 2025')
ok('January does not slide into December', monthLabel('2026-01'), 'January 2026')

console.log(`\nmonths: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
