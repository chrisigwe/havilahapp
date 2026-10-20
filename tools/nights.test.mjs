import { nightsInWindow } from '../src/lib/nights.js'

const TODAY = '2026-10-20'
const FROM = '2026-10-01'
const TO = '2026-10-21'          // the current month runs to tonight inclusive
let pass = 0, fail = 0
const t = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} = ${got}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`) }
}

t('one night, in and out',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-10-05', actual_out: '2026-10-06' }, FROM, TO, TODAY), 1)

t('five-night stay',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-10-05', actual_out: '2026-10-10' }, FROM, TO, TODAY), 5)

t('arrived last month, left on the 4th — only October nights',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-09-28', actual_out: '2026-10-04' }, FROM, TO, TODAY), 3)

t('still here, arrived on the 18th — 18th, 19th and tonight',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-18', scheduled_out: '2026-10-21' }, FROM, TO, TODAY), 3)

t('over-staying: scheduled out on the 19th, still in the room',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-17', scheduled_out: '2026-10-19' }, FROM, TO, TODAY), 4)

t('long stay since August, still here',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-08-01', scheduled_out: '2026-12-31' }, FROM, TO, TODAY), 20)

t('reservation for November counts nothing yet',
  nightsInWindow({ status: 'reserved', check_in_date: '2026-11-02', scheduled_out: '2026-11-07' }, FROM, TO, TODAY), 0)

t('reservation due today but not arrived',
  nightsInWindow({ status: 'reserved', check_in_date: '2026-10-20', scheduled_out: '2026-10-21' }, FROM, TO, TODAY), 0)

t('same-day in and out counts as one',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-10-07', actual_out: '2026-10-07' }, FROM, TO, TODAY), 1)

t('entirely last month',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-09-02', actual_out: '2026-09-05' }, FROM, TO, TODAY), 0)

t('checked in tonight',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-20', scheduled_out: '2026-10-21' }, FROM, TO, TODAY), 1)

t('checked out this morning — last night counted, today not',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-10-19', actual_out: '2026-10-20' }, FROM, TO, TODAY), 1)

// A checkout undone to make a correction. While it sits reopened the
// status reads 'occupied' with actual_out cleared, and the real
// departure is held in pre_reopen_actual_out.
t('reopened for a correction — counts the nights actually slept',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-05',
                   scheduled_out: '2026-10-08', actual_out: null,
                   pre_reopen_actual_out: '2026-10-08' }, FROM, TO, TODAY), 3)

t('reopened days ago — the correction adds no nights',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-01',
                   scheduled_out: '2026-10-02', actual_out: null,
                   pre_reopen_actual_out: '2026-10-02' }, FROM, TO, TODAY), 1)

t('reopened, then checked out again with a corrected date',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-10-05',
                   scheduled_out: '2026-10-08', actual_out: '2026-10-09',
                   pre_reopen_actual_out: null }, FROM, TO, TODAY), 4)

t('a real guest still in the room is unaffected',
  nightsInWindow({ status: 'occupied', check_in_date: '2026-10-18',
                   scheduled_out: '2026-10-19', pre_reopen_actual_out: null }, FROM, TO, TODAY), 3)

// a finished month, where the window is the whole month
t('finished month: stay spanning the end',
  nightsInWindow({ status: 'checked_out', check_in_date: '2026-09-28', actual_out: '2026-10-03' },
                 '2026-09-01', '2026-10-01', TODAY), 3)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
