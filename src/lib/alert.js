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

// Two short pulses — deliberately not a long chime. Staff are on a
// busy floor and this fires on a count needing verification, which
// wants attention without being startling. Gain ramps rather than
// switching on and off, because an abrupt square edge produces an
// audible click on most phone speakers.
export function pulseAlert({ times = 2 } = {}) {
  const c = audioCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => {})
  const start = c.currentTime
  for (let i = 0; i < times; i++) {
    const t = start + i * 0.28
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.20)
    osc.connect(gain).connect(c.destination)
    osc.start(t)
    osc.stop(t + 0.22)
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
