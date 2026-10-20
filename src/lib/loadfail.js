// Nothing on this app should ever read as "there is none" when the
// truth is "it did not load" (20 October 2026).
//
// Forty-five places caught a failed load and emptied the screen:
// `.catch(() => setRows([]))`. The list then rendered its empty state —
// "No guests owing", "Nothing unaccounted for", "Nothing waiting from
// the front desk" — and every one of those is a claim about money that
// nobody checked. A clerk reading "no guests owing" on a night the
// query timed out closes the day believing it.
//
// Each of those catches now records the failure here, by the name of
// the thing that did not arrive, and Shell shows what is missing. The
// empty state still renders — the screen stays usable — but it can no
// longer be mistaken for an answer.
//
// Deliberately not a toast: a toast is gone in four seconds and these
// matter for as long as the figure is wrong.

const failures = new Map()   // label -> { label, message, at }
const listeners = new Set()

function emit() {
  const list = [...failures.values()]
  for (const fn of listeners) fn(list)
}

// label: what the person was looking at, in their words — "The room
// board", "Money waiting from the front desk". Never a function name.
export function noteLoadFailure(label, err) {
  failures.set(label, {
    label,
    message: err?.message || String(err || 'could not load'),
    at: Date.now(),
  })
  emit()
}

// A later attempt at the same thing succeeded, so stop saying it failed.
export function clearLoadFailure(label) {
  if (failures.delete(label)) emit()
}

export function clearAllLoadFailures() {
  if (failures.size) { failures.clear(); emit() }
}

export function subscribeLoadFailures(fn) {
  listeners.add(fn)
  fn([...failures.values()])
  return () => listeners.delete(fn)
}

// Wrap a load so a failure is recorded and a later success clears it.
// The caller's own .catch still runs and still empties the list — the
// screen behaves exactly as before, it just no longer lies about why.
export function tracked(label, promise) {
  return promise.then(v => { clearLoadFailure(label); return v })
                .catch(e => { noteLoadFailure(label, e); throw e })
}
