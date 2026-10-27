import { useEffect, useRef, useState } from 'react'
import Logo from './Logo'
import PendingBanner from './PendingBanner'
import UpdateBanner from './UpdateBanner'
import StaffOfMonthBanner from './StaffOfMonthBanner'
import ReservationBanner from './ReservationBanner'
import NavIcon from './NavIcon'
import { tabsFor, countBadgeTabFor } from '../lib/tabs'
import ReadOnlyBanner from './ReadOnlyBanner'
import LoadFailures from './LoadFailures'
import { clearAllLoadFailures } from '../lib/loadfail'
import NotificationSetup from './NotificationSetup'
import { signOutCleanly } from '../lib/push'
import { moreItemsFor } from '../pages/More'

// GM/admin/manager oversee everything rather than doing one
// department's day-to-day work — their four most load-bearing
// screens (today's money across departments, the room board, who
// owes what) get promoted to direct tabs; Sales/Store/Stock move
// into More for them specifically, since storekeeper and other
// department-scoped roles still need those as their own primary tabs.

// Pages that read better as a single column even on a big screen.
const NARROW = ['sales', 'store', 'more', 'mypay', 'staysettings', 'staffaccounts']

const MORE = ['mypay', 'tillchecks', 'dailysales', 'roomboard', 'credit', 'recovery', 'count', 'catalog', 'variance', 'fix',
              'staysettings', 'sales', 'store', 'stock']

export default function Shell({ staff, tab, onTab, children,
                                branches = [], viewBranch, onBranch, pendingCount = 0,
                                alertEligible = false, recordsSales = false }) {
  // A new screen asks its own questions. Clearing here stops a failure
  // from one tab being read as a fault on the next — the loads that
  // matter here will report again if they still cannot answer.
  useEffect(() => { clearAllLoadFailures() }, [tab])

  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  // The tab bar gets out of the way while you read down a page and
  // comes back the moment you scroll up (19 October 2026). The same
  // behaviour as tabBarMinimizeBehavior(.onScrollDown) on iOS, which is
  // a SwiftUI setting and has no equivalent on the web — so it is done
  // here by hand.
  //
  // Never hidden near the top of a page, so it cannot be missing when
  // someone has not scrolled anywhere. Small movements are ignored, or
  // the bar would flicker on every thumb tremor.
  const [navDown, setNavDown] = useState(false)
  // The big page title at the top of a screen shrinks into the bar as you
  // scroll, and comes back at the top — WhatsApp's Chats screen, which is
  // how Chris asked for it (26 October 2026).
  //
  // Written as a CSS custom property rather than React state. A state
  // update per scroll frame re-renders the whole shell and every page
  // under it, which is exactly the jank this is supposed to avoid; a
  // property on one element lets the compositor do the work. It rides in
  // the scroll handler the tab bar already runs, so there is still only
  // one listener.
  //
  // On the SHELL, not on the bar. The large title sits below the bar as
  // its sibling, and a custom property inherits down the tree, never
  // sideways — set on the bar it reached the compact title and nothing
  // else, so the large one simply never faded. Caught by measuring it
  // rather than by reading it back.
  const shellRef = useRef(null)
  const barRef = useRef(null)
  const TITLE_RUN = 52   // px of scroll the handover takes

  // The bar's real height, published so whatever pins beneath it lands
  // flush. Measured rather than assumed: the bar grows when a branch
  // picker is present, and a hard-coded offset would leave a gap on one
  // account and an overlap on another.
  useEffect(() => {
    const measure = () => {
      const h = barRef.current?.getBoundingClientRect().height
      // Hidden on a laptop (lg:hidden), where the height is 0 and
      // nothing should pin to it.
      shellRef.current?.style.setProperty('--hv-bar', h ? `${Math.round(h)}px` : '0px')
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ro && barRef.current) ro.observe(barRef.current)
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  useEffect(() => {
    let last = window.scrollY
    let frame = 0
    const paint = (y) => {
      const el = shellRef.current
      if (!el) return
      const t = Math.min(1, Math.max(0, y / TITLE_RUN))
      el.style.setProperty('--hv-t', t.toFixed(3))
    }
    paint(window.scrollY)
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const y = window.scrollY
        // Before the movement guard below: the title tracks the scroll
        // continuously, while the tab bar only reacts to a deliberate
        // push in one direction.
        paint(y)
        const dy = y - last
        if (Math.abs(dy) < 6) return
        last = y
        if (y < 80) { setNavDown(false); return }
        setNavDown(dy > 0)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  // A tab change scrolls to a new page; the bar must be there when it does.
  useEffect(() => {
    setNavDown(false)
    shellRef.current?.style.setProperty('--hv-t', '0')
  }, [tab])
  // The bar comes from tabsFor() — the single definition shared with
  // the More menu and the landing screen. See lib/tabs.js.
  const tabs = tabsFor(staff.role, { recordsSales, canRecordSales: !!staff.can_record_sales })
  const countBadgeTab = countBadgeTabFor(staff.role, { recordsSales, canRecordSales: !!staff.can_record_sales })
  const directTabKeys = new Set(tabs.map(([k]) => k))
  const moreItems = moreItemsFor(staff.role, recordsSales, !!staff.is_read_only, !!staff.can_record_sales)
  // The name of the screen you are on, from the same two lists the bar
  // and the More menu are built from — so a tab renamed in one place is
  // renamed in the title too.
  // Falls back to the tab's own key rather than to nothing (27 October
  // 2026). An empty title rendered no large title and an empty compact
  // one, so the whole bar read as missing — which is what Android showed.
  // A page the two lists do not name is a gap worth seeing, not hiding.
  const pageTitle = tabs.find(([k]) => k === tab)?.[1]
    || moreItems.find(i => i.key === tab)?.label
    || (tab ? tab.charAt(0).toUpperCase() + tab.slice(1) : 'Havilah')

  // One-shot bounce when a tab becomes the selected one. Driven by a key
  // that changes on selection, so the animation restarts every time —
  // a CSS rule alone would not re-run for a tab already mounted.
  const [popKey, setPopKey] = useState(0)
  const lastTab = useRef(tab)
  useEffect(() => {
    if (lastTab.current !== tab) { lastTab.current = tab; setPopKey(n => n + 1) }
  }, [tab])
  return (
    <div ref={shellRef} className="min-h-dvh pb-24 lg:pb-8">
      {/* Laptop and desktop: the tabs live in a left sidebar instead of the
          floating bar. Same tabs, same More items, same badges — taken from
          the same lists, so the two layouts cannot drift apart. */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-60 flex-col border-r border-line bg-surface/40 z-30">
        <div className="px-5 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <Logo className="w-6 h-6 shrink-0" />
            <span className="font-bold text-xl">Havilah</span>
          </div>
          <div className="text-dim text-sm mt-1 truncate">{staff.full_name}</div>
          {branches.length > 1 && (
            <select value={viewBranch || ''} onChange={e => onBranch(e.target.value)}
              className="mt-3 w-full h-9 px-2 rounded-lg bg-surface border border-line text-sm">
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.slug.toUpperCase()}</option>
              ))}
            </select>
          )}
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
          {tabs.filter(([k]) => k !== 'more').map(([k, label]) => {
            const active = tab === k
            return (
              <button key={k} onClick={() => onTab(k)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3 h-11 rounded-xl text-left
                            ${active ? 'bg-amber/20 text-amber font-bold' : 'text-dim hover:bg-white/5 hover:text-ink font-semibold'}`}>
                <NavIcon tab={k} filled={active} className="w-5 h-5 shrink-0" />
                <span className="flex-1">{label}</span>
                {k === countBadgeTab && pendingCount > 0 && (
                  <span className="min-w-[1.25rem] h-5 px-1 rounded-full bg-clay text-bg text-xs font-bold flex items-center justify-center">
                    {pendingCount > 9 ? '9+' : pendingCount}
                  </span>
                )}
              </button>
            )
          })}
          {moreItems.length > 0 && (
            <>
              <div className="px-3 pt-5 pb-1 text-xs uppercase tracking-wide text-dim/70 font-semibold">More</div>
              {moreItems.map(i => {
                const active = tab === i.key
                return (
                  <button key={i.key} onClick={() => onTab(i.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full flex items-center gap-3 px-3 h-10 rounded-xl text-left text-[0.95rem]
                                ${active ? 'bg-amber/20 text-amber font-bold' : 'text-dim hover:bg-white/5 hover:text-ink'}`}>
                    <NavIcon tab={i.key} filled={active} className="w-5 h-5 shrink-0" />
                    <span className="flex-1">{i.label}</span>
                    {i.key === 'count' && pendingCount > 0 && (
                      <span className="min-w-[1.25rem] h-5 px-1 rounded-full bg-clay text-bg text-xs font-bold flex items-center justify-center">
                        {pendingCount > 9 ? '9+' : pendingCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </nav>
        <div className="p-3 border-t border-line">
          <button onClick={() => setConfirmingSignOut(true)}
            className="w-full h-10 rounded-xl border border-line text-dim text-sm hover:text-ink">
            Sign out
          </button>
        </div>
      </aside>

      {/* The bar stays; the page title below it is what moves. Both the
          logo and the branch picker keep their places, so nothing a
          thumb is used to reaching moves around while scrolling. */}
      <header ref={barRef} className="lg:hidden hv-nav hv-nav--parted px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <Logo className="w-5 h-5 shrink-0 self-center" />
            {/* Two labels in one place: the app's name at the top of a
                page, the page's name once you have scrolled. One is
                always fully faded, so they never read as two titles. */}
            <span className="relative min-w-0 flex-1 h-6 overflow-hidden">
              <span className="hv-bar-brand absolute inset-0 font-bold text-lg truncate">
                Havilah
              </span>
              <span className="hv-nav-title absolute inset-0 font-bold text-lg truncate">
                {pageTitle}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {branches.length > 1 && (
              <select value={viewBranch || ''} onChange={e => onBranch(e.target.value)}
                className="h-9 px-2 rounded-lg bg-surface border border-line text-sm">
                {branches.map(b => (
                  <option key={b.id} value={b.id}>{b.slug.toUpperCase()}</option>
                ))}
              </select>
            )}
            <button onClick={() => setConfirmingSignOut(true)}
              className="h-9 px-3 rounded-lg border border-line text-dim text-sm">
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* The large title, in the flow, so it scrolls up and under the
          blur rather than being animated out from under the thumb. */}
      {(
        <div className="lg:hidden hv-large-title px-5 pt-1 pb-2">
          {/* 1.6rem, down from 2rem (Chris, 27 October 2026). Still
              clearly the page's title and still the largest thing on the
              screen, without taking a third of a phone's first view
              before any content starts. */}
          <h1 className="text-[1.6rem] leading-tight font-extrabold tracking-tight truncate">
            {pageTitle}
          </h1>
          <p className="text-dim text-sm truncate">{staff.full_name}</p>
        </div>
      )}
      <div className="lg:pl-60">
      <div className={`mx-auto lg:pt-6 ${NARROW.includes(tab) ? 'lg:max-w-3xl' : 'lg:max-w-6xl'}`}>
      <PendingBanner />
      <UpdateBanner />
      {/* Pinned under the bar on a phone (Chris, 27 October 2026), static
          on a laptop where there is no bar to pin under. */}
      <div className="hv-under-nav lg:static">
        <StaffOfMonthBanner branchId={staff.branch_id} />
      </div>
      {['front_desk', 'manager', 'gm', 'admin'].includes(staff.role) && (
        <ReservationBanner branchId={staff.branch_id} tab={tab} onTab={onTab} />
      )}
      <ReadOnlyBanner readOnly={staff.is_read_only} />
      <NotificationSetup staff={staff} alertEligible={alertEligible} />
      {/* Above the page, because what is missing from a figure has to be
          read before the figure is. */}
      <LoadFailures />
      {children}
      </div>
      </div>
      {confirmingSignOut && (
        <div className="fixed inset-0 z-[70] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Sign out?</h2>
          <p className="text-dim mt-2">
            You'll need your password to sign back in. If this is your own
            phone, there's usually no need to sign out at all — just close the app.
          </p>
          <button onClick={() => signOutCleanly()}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold">
            Sign out
          </button>
          <button onClick={() => setConfirmingSignOut(false)}
            className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
      <nav className={`lg:hidden fixed bottom-3 inset-x-3 z-40 transition-transform duration-200 ease-out ${
        navDown ? 'translate-y-[150%]' : 'translate-y-0'}`}
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto max-w-md flex gap-1 p-1.5 rounded-[28px]
                         bg-surface/70
                         border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
          {tabs.map(([k, label]) => {
            const active = tab === k || (k === 'more' && MORE.includes(tab) && !directTabKeys.has(tab))
            return (
              <button key={k} onClick={() => onTab(k)}
                aria-current={active ? 'page' : undefined}
                style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                className="nav-tab relative flex-1 flex flex-col items-center justify-center
                           gap-1 py-2 rounded-full">

                {/* The capsule wraps the WHOLE tab — icon and label —
                    like WhatsApp's, not just the icon. */}
                <span className={`nav-pill absolute inset-0 rounded-full bg-amber/20 ${
                  active ? 'opacity-100' : 'opacity-0'}`} />

                {/* Hollow when resting, solid when selected. That, more
                    than colour, is what marks the chosen tab — and it
                    still reads on a dim or small screen. */}
                <span key={active ? `on-${popKey}` : 'off'}
                  className={`relative ${active ? 'nav-ico-pop' : ''}`}>
                  <NavIcon tab={k} filled={active}
                    className={`nav-ico block w-6 h-6 ${active ? 'text-amber' : 'text-dim'}`} />
                </span>

                <span className={`relative text-[0.7rem] leading-none ${
                  active ? 'text-amber font-bold' : 'text-dim font-semibold'}`}>
                  {label}
                </span>

                {/* On the icon's top-right, which with the capsule now
                    spanning the whole tab means offsetting from centre. */}
                {k === countBadgeTab && pendingCount > 0 && (
                  <span className="absolute top-1 left-1/2 translate-x-1.5 min-w-[1.1rem] h-[1.1rem] px-1
                                    rounded-full bg-clay text-bg text-[0.6rem] font-bold flex items-center justify-center">
                    {pendingCount > 9 ? '9+' : pendingCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
