import { useState } from 'react'
import { supabase } from '../lib/supabase'
import Logo from './Logo'
import PendingBanner from './PendingBanner'
import UpdateBanner from './UpdateBanner'
import StaffOfMonthBanner from './StaffOfMonthBanner'
import NavIcon from './NavIcon'
import { tabsFor, countBadgeTabFor } from '../lib/tabs'
import ReadOnlyBanner from './ReadOnlyBanner'
import NotificationSetup from './NotificationSetup'
import { signOutCleanly } from '../lib/push'

// GM/admin/manager oversee everything rather than doing one
// department's day-to-day work — their four most load-bearing
// screens (today's money across departments, the room board, who
// owes what) get promoted to direct tabs; Sales/Store/Stock move
// into More for them specifically, since storekeeper and other
// department-scoped roles still need those as their own primary tabs.

const MORE = ['dailysales', 'roomboard', 'credit', 'recovery', 'count', 'catalog', 'variance', 'fix',
              'staysettings', 'sales', 'store', 'stock']

export default function Shell({ staff, tab, onTab, children,
                                branches = [], viewBranch, onBranch, pendingCount = 0,
                                alertEligible = false, recordsSales = false }) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  // The bar comes from tabsFor() — the single definition shared with
  // the More menu and the landing screen. See lib/tabs.js.
  const tabs = tabsFor(staff.role, { recordsSales })
  const countBadgeTab = countBadgeTabFor(staff.role, { recordsSales })
  const directTabKeys = new Set(tabs.map(([k]) => k))
  return (
    <div className="min-h-dvh pb-24">
      <header className="px-5 pt-5 pb-3 flex items-center justify-between gap-3">
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
      <PendingBanner />
      <UpdateBanner />
      <StaffOfMonthBanner branchId={staff.branch_id} />
      <ReadOnlyBanner readOnly={staff.is_read_only} />
      <NotificationSetup staff={staff} alertEligible={alertEligible} />
      {children}
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
      <nav className="fixed bottom-3 inset-x-3 z-40"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto max-w-md flex gap-1 p-1.5 rounded-[28px]
                         bg-surface/70 backdrop-blur-xl backdrop-saturate-150
                         border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
          {tabs.map(([k, label]) => {
            const active = tab === k || (k === 'more' && MORE.includes(tab) && !directTabKeys.has(tab))
            return (
              <button key={k} onClick={() => onTab(k)}
                className="relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2 rounded-[20px] transition-colors">
                <span className={`absolute inset-0 rounded-[20px] transition-opacity ${
                  active ? 'opacity-100 bg-amber/20' : 'opacity-0'}`} />
                <NavIcon tab={k} className={`relative w-5 h-5 ${active ? 'text-amber' : 'text-dim'}`} />
                <span className={`relative text-xs font-semibold ${active ? 'text-amber' : 'text-dim'}`}>
                  {label}
                </span>
                {k === countBadgeTab && pendingCount > 0 && (
                  <span className="absolute top-1 right-1/2 translate-x-3.5 min-w-[1.1rem] h-[1.1rem] px-1
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
