import { useEffect, useState } from 'react'

// A gentle "add to home screen" prompt. Two platforms, handled
// differently:
//   - Android/Chrome fires beforeinstallprompt → we show a one-tap
//     Install button.
//   - iOS Safari has no such event → we show short instructions
//     (Share → Add to Home Screen), since there's no way to trigger
//     it programmatically.
// Never shows when already installed (running standalone), and stays
// dismissed for a while once closed so it isn't nagging.

const DISMISS_KEY = 'havilah-install-dismissed'
const DISMISS_DAYS = 14

function recentlyDismissed() {
  try {
    const v = localStorage.getItem(DISMISS_KEY)
    if (!v) return false
    return Date.now() - Number(v) < DISMISS_DAYS * 864e5
  } catch { return false }
}

export default function InstallHint() {
  const [deferred, setDeferred] = useState(null)   // android prompt event
  const [show, setShow] = useState(false)
  const [iosHint, setIosHint] = useState(false)

  useEffect(() => {
    // already installed? never show.
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true
    if (standalone || recentlyDismissed()) return

    const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    const isSafari = isIOS && /safari/i.test(window.navigator.userAgent)
      && !/crios|fxios/i.test(window.navigator.userAgent)

    // Android/Chrome: catch the install event
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); setShow(true) }
    window.addEventListener('beforeinstallprompt', onPrompt)

    // iOS Safari: no event exists, show manual instructions after a
    // short delay so it doesn't slam up on first paint
    let t
    if (isSafari) t = setTimeout(() => { setIosHint(true); setShow(true) }, 3000)

    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); clearTimeout(t) }
  }, [])

  function dismiss() {
    setShow(false)
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ }
  }

  async function install() {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice
    setDeferred(null); setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed bottom-24 inset-x-4 z-40 rounded-2xl border border-amber bg-surface p-4 shadow-lg">
      {iosHint ? (
        <>
          <div className="font-semibold">Add Havilah to your Home Screen</div>
          <div className="text-dim text-sm mt-1">
            Tap the Share button below, then choose <span className="text-ink">“Add to Home Screen.”</span>
            {' '}Opens like an app, no browser bar.
          </div>
          <button onClick={dismiss} className="mt-3 text-dim text-sm underline">Got it</button>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="font-semibold">Install Havilah</div>
            <div className="text-dim text-sm">Add it to your home screen like an app.</div>
          </div>
          <button onClick={dismiss} className="text-dim text-sm px-2">Later</button>
          <button onClick={install} className="h-11 px-4 rounded-xl bg-amber text-bg font-bold">Install</button>
        </div>
      )}
    </div>
  )
}
