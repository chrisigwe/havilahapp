// Notification tone + app icon badge.
//
// The tone is synthesised with Web Audio rather than shipped as an
// audio file: it keeps the PWA payload unchanged, needs no extra
// network fetch (this app is used on patchy connections), and can't
// fail to cache offline.

let ctx = null
function audioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  return ctx
}

// Browsers block audio until the user has interacted with the page.
// Called once from the first tap so later alerts can actually sound.
export function unlockAudio() {
  const c = audioCtx()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

// A reception-bell chime rather than a beep.
//
// The first version was two 0.2 s sine blips at one pitch — quiet, and
// closer to a microwave than a hotel. A bell reads as "someone needs
// you" without being harsh. Timbre comes from inharmonic partials
// (x2.0, x2.76, x5.4 over the fundamental), which is what makes a
// struck bell sound like metal rather than a pure tone.
//
// Two distinct sounds, so staff can tell them apart without looking:
//   'attention' — two rising dings. Something needs YOU: a charge to
//                 approve, a count to verify.
//   'resolved'  — a rising three-note arpeggio. Something you were
//                 waiting on was answered.
function bell(c, t, freq, peak = 0.32, decay = 1.1) {
  const master = c.createGain()
  // Near-instant attack, long exponential decay: the shape of a strike.
  master.gain.setValueAtTime(0.0001, t)
  master.gain.exponentialRampToValueAtTime(peak, t + 0.008)
  master.gain.exponentialRampToValueAtTime(0.0001, t + decay)
  master.connect(c.destination)
  // Partial amplitudes sum to 2.0; x peak 0.32 = 0.64, safely below
  // clipping even with notes overlapping.
  for (const [mult, amp] of [[1, 1], [2.0, 0.5], [2.76, 0.35], [5.4, 0.15]]) {
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * mult, t)
    g.gain.setValueAtTime(amp, t)
    osc.connect(g).connect(master)
    osc.start(t)
    osc.stop(t + decay + 0.05)
  }
}

export function pulseAlert({ variant = 'attention' } = {}) {
  const c = audioCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => {})
  const t = c.currentTime
  if (variant === 'resolved') {
    bell(c, t,        1046.5, 0.26, 0.9)   // C6
    bell(c, t + 0.13, 1318.5, 0.26, 0.9)   // E6
    bell(c, t + 0.26, 1568.0, 0.30, 1.3)   // G6
  } else {
    bell(c, t,        784.0)               // G5
    bell(c, t + 0.20, 1046.5, 0.34, 1.4)   // C6
  }
}

// Badge on the installed app icon. Supported on installed PWAs
// (Android/Chrome, iOS 16.4+ when added to the home screen) and a
// no-op elsewhere — never throw, since this is decoration.
export function setAppBadge(count) {
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count)
    else if (navigator.clearAppBadge) navigator.clearAppBadge()
  } catch { /* unsupported — ignore */ }
}
