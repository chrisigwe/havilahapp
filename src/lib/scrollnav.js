// Whether the bottom tab bar should be down, decided from scroll
// positions alone — pure, so the decision can be tested against a
// recorded sequence instead of being judged on a phone.
//
// Why it is not simply "did the number go up": an iPhone springs the
// page PAST its own end when a flick reaches the bottom, and back again,
// inside a fraction of a second. Read naively that is down, then up,
// then down — three instructions inside one 200ms slide, each
// interrupting the last, leaving the bar at rest somewhere between
// hidden and shown. Android stretches or glows at the end of a list
// instead of moving the page, which is why it was never seen there.
//
// Two guards, and both are right on their own terms whatever the bar
// happens to do: a bounce is not a thumb movement, and a slide that has
// only just started should be allowed to finish before it is reversed.
// How long the bar's own CSS transition lasts, in ms. Shared so the
// settle guard below and the screen-awake loop in Shell cannot drift
// from the stylesheet: .hv-tabbar transitions transform over 200ms.
export const NAV_SLIDE_MS = 200

export const NAV = {
  dead: 6,       // px of movement below which nothing is a deliberate scroll
  top: 80,       // px from the top where the bar always comes back
  settle: NAV_SLIDE_MS + 60,   // ms a slide is left alone before it may reverse
}

export const navStart = (y = 0) => ({ last: y, down: false, movedAt: -Infinity })

export function navStep(s, y, max, now) {
  // Outside the page's own range: iOS rubber band, not a scroll. Note
  // `last` is deliberately NOT advanced here, so the movement is measured
  // from where the page really was once it settles back.
  if (y < 0 || y > max + 1) return s

  const dy = y - s.last
  if (Math.abs(dy) < NAV.dead) return s
  const next = { ...s, last: y }

  // At the top the bar always returns, with no waiting: this is the one
  // case where the person is looking straight at where it belongs.
  if (y < NAV.top) return next.down ? { ...next, down: false, movedAt: now } : next

  if (now - s.movedAt < NAV.settle) return next

  const down = dy > 0
  return down === s.down ? next : { ...next, down, movedAt: now }
}
