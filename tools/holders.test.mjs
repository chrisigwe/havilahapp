// Reading a login's history back to a person. An entry names the
// account; these functions say who was holding it that day, so the
// answer has to be right about dates and honest when it does not know.
import { handovers, resets, otherLines, holderOn, heldBy } from '../src/lib/holders.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`) }
}

// Exactly the shape reset-staff-password appends.
const NOTE = [
  '2026-09-01: handed over to Chidera Okeke (by GM)',
  '2026-11-03: password reset by GM',
  '2026-11-21: handed over to Grace Nwosu (by GM)',
].join('\n')

eq('both hand-overs, oldest first', handovers(NOTE),
   [{ on: '2026-09-01', to: 'Chidera Okeke', by: 'GM' },
    { on: '2026-11-21', to: 'Grace Nwosu', by: 'GM' }])

eq('a reset is not a hand-over', resets(NOTE), [{ on: '2026-11-03', by: 'GM' }])

// The question this exists for: an entry dated 18 November says "Chef".
eq('who held it on 18 November', holderOn(NOTE, '2026-11-18'),
   { name: 'Chidera Okeke', since: '2026-09-01', by: 'GM' })
eq('and on 22 November', holderOn(NOTE, '2026-11-22'),
   { name: 'Grace Nwosu', since: '2026-11-21', by: 'GM' })

// A login handed over on the 21st was that person's FOR the 21st: the
// change happened before the day's entries did.
eq('the day of the hand-over belongs to the new holder',
   holderOn(NOTE, '2026-11-21').name, 'Grace Nwosu')

// Before the first hand-over nobody knows, and saying so is the only
// honest answer. Naming the current holder would put Grace in a room
// she was not in.
eq('before any hand-over there is no record', holderOn(NOTE, '2026-08-31'), null)
eq('an account that never changed hands', holderOn('', '2026-11-18'), null)
eq('a null note', holderOn(null, '2026-11-18'), null)
eq('no date, no claim', holderOn(NOTE, null), null)

// Two on one day: the later line wins, which is the order they were
// appended in.
const SAME_DAY = ['2026-11-21: handed over to A (by GM)',
                  '2026-11-21: handed over to B (by GM)'].join('\n')
eq('two on one day, the last one holds it', holderOn(SAME_DAY, '2026-11-21').name, 'B')

// Ordinary remarks on the account are not history and must not be read
// as one.
const MIXED = ['Works Fridays only.',
               '2026-11-21: handed over to Grace Nwosu (by GM)',
               'Keeps the Minimart key.'].join('\n')
eq('remarks are left out of the history', handovers(MIXED).length, 1)
eq('and kept as remarks', otherLines(MIXED),
   ['Works Fridays only.', 'Keeps the Minimart key.'])

// A hand-over with nobody named: the function writes a reset line
// instead, but a hand-written one must not produce a holder called "".
eq('a hand-over with no name is not a holder',
   handovers('2026-11-21: handed over to    ').length, 0)

// Without "(by …)" it is still a hand-over.
eq('no by-clause', handovers('2026-11-21: handed over to Grace Nwosu'),
   [{ on: '2026-11-21', to: 'Grace Nwosu', by: null }])

// A name with brackets of its own must not lose them to the by-clause.
eq('brackets inside the name',
   handovers('2026-11-21: handed over to Grace Nwosu (Nnewi) (by GM)')[0].to,
   'Grace Nwosu (Nnewi)')

// Periods, newest first, each ending where the next begins.
eq('held by, as periods', heldBy(NOTE),
   [{ name: 'Grace Nwosu', from: '2026-11-21', by: 'GM', until: null },
    { name: 'Chidera Okeke', from: '2026-09-01', by: 'GM', until: '2026-11-21' }])
eq('nothing to show', heldBy(''), [])

// Lines may arrive with Windows endings or odd spacing.
eq('carriage returns and loose spacing',
   handovers('2026-11-21 :  handed over to  Grace Nwosu  (by GM)\r\n')[0],
   { on: '2026-11-21', to: 'Grace Nwosu', by: 'GM' })

console.log(`\nholders: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
