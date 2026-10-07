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
  const [androidHint, setAndroidHint] = useState(null)   // 'chrome' | 'other'

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

    // Android where the browser never offers the one-tap install. Common
    // on Redmi/Xiaomi: their own browser can't install apps at all, and
    // even Chrome needs a permission. Say what to do instead of showing
    // nothing.
    const ua = window.navigator.userAgent
    const isAndroid = /android/i.test(ua)
    let t2
    if (isAndroid) {
      const realChrome = /chrome\//i.test(ua) && !/miuibrowser|xiaomi|ucbrowser|opr\/|opera|samsungbrowser|edga|firefox|; wv\)|fban|fbav|instagram|line\//i.test(ua)
      t2 = setTimeout(() => {
        setAndroidHint(prev => prev || (realChrome ? 'chrome' : 'other'))
        setShow(true)
      }, 6000)
    }
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); clearTimeout(t); clearTimeout(t2) }
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
      {androidHint ? (
        <>
          <div className="font-semibold">Add Havilah to your home screen</div>
          {androidHint === 'chrome' ? (
            <div className="text-dim text-sm mt-1">
              Tap the <span className="text-ink">⋮ menu</span> at the top right of Chrome, then
              {' '}<span className="text-ink">“Install app”</span> or
              {' '}<span className="text-ink">“Add to Home screen”</span>.
              On Redmi/Xiaomi, if nothing appears afterwards: Settings → Apps → Chrome →
              {' '}<span className="text-ink">Other permissions</span> → allow
              {' '}<span className="text-ink">“Create shortcuts on home screen”</span>.
            </div>
          ) : (
            <div className="text-dim text-sm mt-1">
              This browser can't install apps. Open <span className="text-ink">havilahsuite.netlify.app</span>
              {' '}in <span className="text-ink">Google Chrome</span>, then use its ⋮ menu →
              {' '}<span className="text-ink">“Install app.”</span>
            </div>
          )}
          <button onClick={dismiss} className="mt-3 text-dim text-sm underline">Got it</button>
        </>
      ) : iosHint ? (
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
