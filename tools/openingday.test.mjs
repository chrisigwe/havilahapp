import { dayToOpenOn } from '../src/lib/openingday.js'

const TODAY = '2026-11-11', YESTERDAY = '2026-11-10'
let pass = 0, fail = 0
const t = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} -> ${got}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`) }
}
const day = (o) => dayToOpenOn({ today: TODAY, yesterday: YESTERDAY, current: TODAY, ...o })

// The case this exists for: OpenBar at 10am with last night still open.
t('after-service dept, 10am, yesterday not closed',
  day({ recordsAfterService: true, hour: 10, yesterdayChecked: false }), YESTERDAY)

t('after-service dept, 10am, yesterday already closed',
  day({ recordsAfterService: true, hour: 10, yesterdayChecked: true }), TODAY)

// 1am after a late night IS still last night's trading.
t('after-service dept, 1am, yesterday not closed',
  day({ recordsAfterService: true, hour: 1, yesterdayChecked: false }), YESTERDAY)
t('after-service dept, midnight exactly',
  day({ recordsAfterService: true, hour: 0, yesterdayChecked: false }), YESTERDAY)

// Midday is the cut. This is what stops the Restaurant, which never does
// a Total Sales check, sitting on yesterday for the whole evening.
t('after-service dept, exactly midday', day({ recordsAfterService: true, hour: 12, yesterdayChecked: false }), TODAY)
t('after-service dept, 1pm',            day({ recordsAfterService: true, hour: 13, yesterdayChecked: false }), TODAY)
t('after-service dept, 11pm',           day({ recordsAfterService: true, hour: 23, yesterdayChecked: false }), TODAY)
t('after-service dept, 11:59am',        day({ recordsAfterService: true, hour: 11, yesterdayChecked: false }), YESTERDAY)

// Minimart, MainBar, Reception sell and record in the same moment.
t('real-time dept, 10am',  day({ recordsAfterService: false, hour: 10, yesterdayChecked: false }), TODAY)
t('real-time dept, 1am',   day({ recordsAfterService: false, hour: 1,  yesterdayChecked: false }), TODAY)
t('dept with no flag at all', day({ hour: 10, yesterdayChecked: false }), TODAY)

// A chosen date is never overridden, in either direction.
t('person already picked an older day',
  dayToOpenOn({ today: TODAY, yesterday: YESTERDAY, current: '2026-11-03',
                recordsAfterService: true, hour: 10, yesterdayChecked: false }), '2026-11-03')
t('person picked yesterday themselves',
  dayToOpenOn({ today: TODAY, yesterday: YESTERDAY, current: YESTERDAY,
                recordsAfterService: false, hour: 10, yesterdayChecked: false }), YESTERDAY)

// A nonsense hour must not silently mean "morning".
t('hour unknown', day({ recordsAfterService: true, hour: NaN, yesterdayChecked: false }), TODAY)
t('hour out of range', day({ recordsAfterService: true, hour: 99, yesterdayChecked: false }), TODAY)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
