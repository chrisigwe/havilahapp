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
export default function UpdateBanner() {
  const [ready, setReady] = useState(false)
  const [going, setGoing] = useState(false)
  useEffect(() => onUpdateAvailable(() => setReady(true)), [])
  if (!ready) return null
  return (
    <button disabled={going}
      onClick={() => {
        setGoing(true)
        try { navigator.serviceWorker?.getRegistrations?.().then(rs => rs.forEach(r => r.update())) }
        catch { /* reload regardless */ }
        window.location.reload()
      }}
      className="block w-full px-5 py-2 text-sm text-center bg-leaf text-bg font-semibold disabled:opacity-60">
      {going ? 'Updating…' : 'A new version is ready — tap to update'}
    </button>
  )
}
