import { supabase } from './supabase'

// Web Push subscription management.
//
// Why this exists: pulseAlert/setAppBadge in App.jsx only run while
// the app is open and in the foreground. A phone can only alert on its
// home screen icon while the app is closed if a push is delivered to
// the service worker, so that path needs a real subscription and a
// server that sends to it.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// Push is configured only if a VAPID key was built in — without one,
// subscribing throws, so the UI should not offer it.
export const pushConfigured = () => {
  if (!pushSupported()) {
    console.warn('[push] this browser does not support service workers / Push API')
    return false
  }
  if (!VAPID_PUBLIC_KEY) {
    // Silent hiding made this indistinguishable from a broken build
    // during setup. Say so once, in the console, rather than nowhere.
    console.warn('[push] VITE_VAPID_PUBLIC_KEY is not set in this build — '
      + 'the notification prompt stays hidden. Set it in Netlify env vars '
      + 'and redeploy with cache cleared.')
    return false
  }
  return true
}

export const permissionState = () =>
  ('Notification' in window) ? Notification.permission : 'unsupported'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

// Asks permission, subscribes, and stores the subscription so the
// sender knows where to push. Returns true only if fully set up.
export async function enablePush(staff) {
  if (!pushConfigured()) return false
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return false

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const json = sub.toJSON()
  // Keyed on endpoint: one row per device/browser, so the same person
  // signed in on a phone and a desktop gets both, and re-subscribing
  // on the same device updates rather than duplicates.
  const { error } = await supabase.from('push_subscriptions').upsert({
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    staff_id: staff.id,
    branch_id: staff.branch_id,
  }, { onConflict: 'endpoint' })
  if (error) throw error
  return true
}

export async function disablePush() {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  // Remove the row too, or the sender keeps pushing to a dead endpoint.
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
}

export async function isPushEnabled() {
  if (!pushSupported() || permissionState() !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  return !!(await reg.pushManager.getSubscription())
}
