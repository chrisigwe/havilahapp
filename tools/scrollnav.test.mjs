// The tab bar's hide/show decision, run against sequences of scroll
// positions a phone actually produces. The one that matters is the
// bottom bounce: on iPhone a flick to the end of a list pushes scrollY
// past the page's own height and back within a fraction of a second,
// and the bar must not try to follow it.
import { navStart, navStep, NAV } from '../src/lib/scrollnav.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} -> ${got}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`) }
}

const MAX = 900
// Replays a list of [y, msSinceStart] and reports every time the bar
// was told to change, so a flap shows up as a count rather than a mood.
const run = (steps, from = navStart(0)) => {
  let s = from
  const changes = []
  for (const [y, t] of steps) {
    const next = navStep(s, y, MAX, t)
    if (next.down !== s.down) changes.push([t, next.down])
    s = next
  }
  return { state: s, changes }
}

// An ordinary scroll down the page, then back up.
const plain = run([[0,0],[120,60],[320,120],[600,180]])
eq('scrolling down hides the bar', plain.state.down, true)
eq('and only says so once', plain.changes.length, 1)
const back = run([[600,400],[400,460],[200,520]], plain.state)
eq('scrolling up brings it back', back.state.down, false)

// THE BOUNCE. Down to the bottom, past the end, and settling back.
// Every position above 900 is the spring, not a thumb.
const bounce = run([[0,0],[300,60],[650,120],[900,180],
                    [948,210],[972,240],[958,270],[930,300],[905,330],[900,360]])
eq('a bottom bounce leaves the bar hidden', bounce.state.down, true)
eq('and never flips it mid-slide', bounce.changes.length, 1)

// Same sequence with the guards off is the fault itself: if this ever
// stops flapping, the test above has stopped proving anything.
const naive = (steps) => {
  let last = 0, down = false, flips = 0
  for (const [y] of steps) {
    const dy = y - last
    if (Math.abs(dy) < NAV.dead) continue
    last = y
    const next = y < NAV.top ? false : dy > 0
    if (next !== down) { down = next; flips++ }
  }
  return flips
}
eq('unguarded, the same bounce flips the bar repeatedly',
   naive([[0,0],[300,60],[650,120],[900,180],
          [948,210],[972,240],[958,270],[930,300],[905,330],[900,360]]) > 1, true)

// A spring at the TOP gives a negative scrollY on iOS. It must not be
// read as scrolling up into nothing, nor hide the bar.
const topSpring = run([[40,0],[-30,40],[-12,80],[0,120]])
eq('a top bounce leaves the bar shown', topSpring.state.down, false)

// A real reversal is honoured once the slide has had its time.
const reversal = run([[0,0],[400,60]])
eq('hidden on the way down', reversal.state.down, true)
const tooSoon = run([[200,120]], reversal.state)
eq('a reversal inside the slide is not obeyed', tooSoon.state.down, true)
const afterwards = run([[100,500]], reversal.state)
eq('the same reversal after it settles is', afterwards.state.down, false)

// Small movements are still ignored, and the bar still returns at the top.
eq('a 4px drift changes nothing', run([[0,0],[4,40]]).state.down, false)
eq('back at the top the bar returns',
   run([[900,0],[40,600]], { last: 900, down: true, movedAt: 0 }).state.down, false)

console.log(`\nscrollnav: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
