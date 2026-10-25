import { useEffect } from 'react'

// Stop the page behind a full-screen panel from scrolling (Chris,
// 25 October 2026).
//
// The statement opens as `fixed inset-0` over the Credit page, but the
// page underneath never stopped scrolling — so there were two scrollbars
// and a swipe landed on whichever the browser felt like. It read as the
// panel sticking: you drag, the list does not move, because the list
// behind it moved instead.
//
// Both <html> and <body>, deliberately. In standards mode the element
// that actually scrolls is documentElement, so hiding overflow on body
// alone changes nothing. Measured with a real wheel rather than assumed:
// body-only left the page scrolling behind the panel exactly as before.
//
// Restores whatever each had before rather than assuming it was empty,
// so two panels open at once cannot leave the page locked when the inner
// one closes.
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return
    const html = document.documentElement
    const body = document.body
    const prevHtml = html.style.overflow
    const prevBody = body.style.overflow
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => { html.style.overflow = prevHtml; body.style.overflow = prevBody }
  }, [active])
}
