import { useEffect, useState } from 'react'
import { onUpdateAvailable } from '../lib/swUpdate'

// Offers a one-tap refresh when a new version is live, rather than
// reloading out from under someone mid-task.
//
// The tap used to delete every cached file first, then reload. That was
// pointless and harmful: sw.js is network-first, so cached files are
// only ever served when there is no connection — a fresh deploy is
// picked up from the network either way. Clearing the cache while the
// page was still fetching from it meant the reload could land with
// files half gone, and the app came up black. Reopening it cleared
// that, which is exactly what a torn-down cache looks like.
//
// So the tap now just reloads. The service worker is asked to check for
// its own new version first, but the reload does not wait on it — that
// call used to be able to hang on a weak connection and leave the
// person tapping a button that appeared to do nothing.
//
// WHY IT LOOKS LIKE THIS (Chris, 5 November 2026). It was a thin green
// strip reading "A new version is ready — tap to update", and people
// scrolled past it for days. Three reasons, all fixed here:
//
//   it read as a status message, not something to tap — so it is now a
//   card with a button in it, and a dot that moves to catch the eye;
//
//   "a new version" is about the software, not about them — so it says
//   what they get, in their words;
//
//   "update" sounds like it might cost you what you are in the middle
//   of — so it says plainly that saved work is safe, and tells someone
//   mid-entry to finish first. That last line is the honest one: a
//   reload DOES lose a half-typed order, and pretending otherwise is
//   how you teach people not to believe the banner.
export default function UpdateBanner() {
  const [ready, setReady] = useState(false)
  const [going, setGoing] = useState(false)
  useEffect(() => onUpdateAvailable(() => setReady(true)), [])
  if (!ready) return null
  return (
    <div className="px-5 pt-3">
      <button disabled={going}
        onClick={() => {
          setGoing(true)
          try { navigator.serviceWorker?.getRegistrations?.().then(rs => rs.forEach(r => r.update())) }
          catch { /* reload regardless */ }
          window.location.reload()
        }}
        className="w-full rounded-2xl border-2 border-leaf bg-leaf/10 px-4 py-3
                   flex items-center gap-3 text-left active:opacity-70 disabled:opacity-60">
        <span className="relative shrink-0 w-10 h-10 rounded-full bg-leaf/20
                         flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-leaf" fill="none"
               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v10" />
            <path d="M8 10l4 4 4-4" />
            <path d="M5 19h14" />
          </svg>
          {!going && (
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-leaf
                             animate-pulse" aria-hidden="true" />
          )}
        </span>

        <span className="flex-1 min-w-0">
          <span className="block font-bold text-leaf leading-tight">
            {going ? 'Getting the new version…' : 'The app has been improved'}
          </span>
          <span className="block text-dim text-xs mt-0.5 leading-snug">
            {going
              ? 'One moment.'
              : 'Nothing you saved is lost. Finish what you are typing first.'}
          </span>
        </span>

        {!going && (
          <span className="shrink-0 h-10 px-4 rounded-xl bg-leaf text-bg text-sm font-bold
                           flex items-center">
            Update
          </span>
        )}
      </button>
    </div>
  )
}
