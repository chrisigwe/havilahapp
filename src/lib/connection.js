// IS THERE ACTUALLY A CONNECTION, AND WHEN DID ANYTHING LAST ARRIVE.
//
// Chris, 21 November 2026: "how best do we present 'no internet
// connection' on the app to users so they don't think the app is
// broken?"
//
// The app already said it -- and said the opposite at the same time. A
// dropped signal produced the calm amber bar ("entries will be saved
// and sent when you are back online") AND the red notice ("Something on
// this screen did not load") carrying a developer's sentence like
// "TypeError: Failed to fetch", above a Try again button that reloads
// the whole app. The red one wins, and reloading is the worst advice
// there is with no signal. This module exists so the two can agree.
//
// navigator.onLine is not enough on its own: a phone on hotel wifi with
// no uplink reports online and every request still fails. So a
// connection-class failure counts as offline until something succeeds.
// That is the case the staff actually hit.
import { isConnectionError } from './outbox'

let online = typeof navigator === 'undefined' ? true : navigator.onLine
let lastOkAt = null          // when anything last arrived from the server
let cameBackAt = null        // when the connection last returned
const listeners = new Set()

const state = () => ({ online, lastOkAt, cameBackAt })
const emit = () => { for (const fn of listeners) fn(state()) }

export function subscribeConnection(fn) {
  listeners.add(fn)
  fn(state())
  return () => listeners.delete(fn)
}

export function connectionState() { return state() }

// Something arrived. That is the only proof of a working connection
// there is -- better than navigator.onLine, which only knows whether a
// network exists.
export function noteReachable() {
  lastOkAt = Date.now()
  if (!online) { online = true; cameBackAt = Date.now() }
  emit()
}

// A load failed. Only a connection-class failure means offline: a
// timeout or a permission refusal is the server answering, and saying
// "no connection" then would be a lie that stops people looking for the
// real cause.
export function noteLoadError(err) {
  if (!isConnectionError(err)) return
  if (online) { online = false; emit() }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!online) { online = true; cameBackAt = Date.now(); emit() }
  })
  window.addEventListener('offline', () => {
    if (online) { online = false; emit() }
  })
}
