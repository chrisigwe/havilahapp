import { useEffect, useRef, useState } from 'react'
import Logo from './Logo'
import PendingBanner from './PendingBanner'
import UpdateBanner from './UpdateBanner'
import StaffOfMonthBanner from './StaffOfMonthBanner'
import NavIcon from './NavIcon'
import { tabsFor, countBadgeTabFor } from '../lib/tabs'
import ReadOnlyBanner from './ReadOnlyBanner'
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
                                alertEligible = false, recordsSales = false, hasPay = false }) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  // The bar comes from tabsFor() — the single definition shared with
  // the More menu and the landing screen. See lib/tabs.js.
  const tabs = tabsFor(staff.role, { recordsSales })
  const countBadgeTab = countBadgeTabFor(staff.role, { recordsSales })
  const directTabKeys = new Set(tabs.map(([k]) => k))
  const moreItems = moreItemsFor(staff.role, recordsSales, hasPay)

  // One-shot bounce when a tab becomes the selected one. Driven by a key
  // that changes on selection, so the animation restarts every time —
  // a CSS rule alone would not re-run for a tab already mounted.
  const [popKey, setPopKey] = useState(0)
  const lastTab = useRef(tab)
  useEffect(() => {
    if (lastTab.current !== tab) { lastTab.current = tab; setPopKey(n => n + 1) }
  }, [tab])
  return (
    <div className="min-h-dvh pb-24 lg:pb-8">
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
        <nav className="flex-1 overflow-y-auto px-3 pb-3">
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

      <header className="lg:hidden px-5 pt-5 pb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Logo className="w-5 h-5 shrink-0" />
          <span className="font-bold text-lg shrink-0">Havilah</span>
          <span className="text-dim text-sm truncate">· {staff.full_name}</span>
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
      </header>
      <div className="lg:pl-60">
      <div className={`mx-auto lg:pt-6 ${NARROW.includes(tab) ? 'lg:max-w-3xl' : 'lg:max-w-6xl'}`}>
      <PendingBanner />
      <UpdateBanner />
      <StaffOfMonthBanner branchId={staff.branch_id} />
      <ReadOnlyBanner readOnly={staff.is_read_only} />
      <NotificationSetup staff={staff} alertEligible={alertEligible} />
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
      <nav className="lg:hidden fixed bottom-3 inset-x-3 z-40"
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
