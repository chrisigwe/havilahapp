import { supabase } from './supabase'

// Attendance by location. While someone has the app open between 9:00am and
// 8:00pm (Lagos), their phone's position is sent to the database, which alone
// decides whether they are at the branch and records first-in / last-seen.
// A position from outside the branch, or outside those hours, is never stored.
// GM and admin are not tracked. Nothing here can slow or break the app:
// every failure is ignored.
const EVERY_MS = 10 * 60 * 1000
const lagosMinutes = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date())
  const h = Number(p.find(x => x.type === 'hour').value) % 24
  return h * 60 + Number(p.find(x => x.type === 'minute').value)
}
const inHours = () => { const m = lagosMinutes(); return m >= 9 * 60 && m <= 20 * 60 }

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(Object.assign(new Error('Location is not available on this device.'), { code: 0 }))
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject(e),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 })
  })
}

export function startPresence(staff) {
  if (!staff || ['gm', 'admin'].includes(staff.role) || staff.is_read_only) return () => {}
  let last = 0, busy = false, stopped = false
  const send = async () => {
    if (stopped || busy || !inHours()) return
    if (document.visibilityState !== 'visible') return
    if (Date.now() - last < EVERY_MS - 5000) return
    busy = true; last = Date.now()
    try {
      const pos = await currentPosition()
      await supabase.rpc('record_presence', { p_lat: pos.lat, p_lng: pos.lng, p_accuracy: pos.accuracy, p_denied: false })
    } catch (e) {
      if (e && e.code === 1) {   // permission denied
        try { await supabase.rpc('record_presence', { p_lat: null, p_lng: null, p_accuracy: null, p_denied: true }) } catch { /* ignore */ }
      }
    } finally { busy = false }
  }
  const onShow = () => { if (document.visibilityState === 'visible') send() }
  document.addEventListener('visibilitychange', onShow)
  const id = setInterval(send, 60 * 1000)   // checks every minute; sends at most every 10
  send()
  return () => { stopped = true; clearInterval(id); document.removeEventListener('visibilitychange', onShow) }
}
