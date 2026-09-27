import { useEffect, useState } from 'react'
import { pushConfigured, permissionState, enablePush, isPushEnabled } from '../lib/push'

// Shown only to staff who actually receive alerts, and only until they
// decide. Deliberately not an automatic permission prompt on load:
// browsers permanently block a site that asks and gets dismissed, so
// the ask has to follow a tap the person chose to make.
export default function NotificationSetup({ staff, alertEligible }) {
  const [state, setState] = useState('checking')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!alertEligible || !pushConfigured()) { setState('hide'); return }
    const perm = permissionState()
    // 'denied' means the browser will not ask again — nagging is
    // pointless, so hide rather than show a button that cannot work.
    if (perm === 'denied') { setState('hide'); return }
    isPushEnabled().then(on => setState(on ? 'hide' : 'offer')).catch(() => setState('offer'))
  }, [alertEligible])

  if (state !== 'offer') return null

  return (
    <div className="px-5 py-2 bg-amber/10 border-b border-amber/40 flex items-center gap-3">
      <p className="text-dim text-sm flex-1">
        Get alerts on your home screen even when the app is closed.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const ok = await enablePush(staff)
            setState(ok ? 'hide' : 'hide')
          } catch { setState('hide') }
          setBusy(false)
        }}
        className="shrink-0 h-9 px-3 rounded-lg bg-amber text-bg font-bold text-sm disabled:opacity-40">
        {busy ? '…' : 'Turn on'}
      </button>
      <button onClick={() => setState('hide')} className="shrink-0 text-dim text-sm">
        Not now
      </button>
    </div>
  )
}
