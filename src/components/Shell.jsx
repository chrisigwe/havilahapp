import { useState } from 'react'
import { supabase } from '../lib/supabase'
import Logo from './Logo'
import PendingBanner from './PendingBanner'
import UpdateBanner from './UpdateBanner'

const STOCK_ROLES = ['storekeeper', 'manager', 'gm', 'admin']
// GM/admin/manager oversee everything rather than doing one
// department's day-to-day work — their four most load-bearing
// screens (today's money across departments, the room board, who
// owes what) get promoted to direct tabs; Sales/Store/Stock move
// into More for them specifically, since storekeeper and other
// department-scoped roles still need those as their own primary tabs.
const OVERSIGHT_ROLES = ['manager', 'gm', 'admin']

const MORE = ['dailysales', 'roomboard', 'credit', 'recovery', 'count', 'catalog', 'variance', 'fix',
              'staysettings', 'sales', 'store', 'stock']

export default function Shell({ staff, tab, onTab, children,
                                branches = [], viewBranch, onBranch, pendingCount = 0 }) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const auditorOnly = staff.role === 'auditor'
  let tabs
  if (OVERSIGHT_ROLES.includes(staff.role)) {
    tabs = [['dailysales', 'Daily sales'], ['roomboard', 'Rooms'], ['credit', 'Credit'], ['more', 'More']]
  } else {
    tabs = auditorOnly ? [['dailysales', 'Daily sales']] : [['sales', 'Sales']]
    // Room Board is front desk's primary tool — a dedicated tab, same
    // treatment as the auditor's Daily Sales. Everyone else who needs
    // it (oversight roles) reaches it through More instead.
    if (staff.role === 'front_desk') tabs.push(['roomboard', 'Rooms'])
    if (STOCK_ROLES.includes(staff.role)) tabs.push(['store', 'Store'])
    tabs.push(['stock', 'Stock'])
    tabs.push(['more', 'More'])
  }
  // Which tab keys are this role's own direct tabs — used below so
  // "More" only highlights for a key that ISN'T already its own
  // button, rather than a hardcoded per-role exclusion list that has
  // to be remembered and extended by hand every time a role's direct
  // tabs change.
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
      {children}
      {confirmingSignOut && (
        <div className="fixed inset-0 z-[70] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Sign out?</h2>
          <p className="text-dim mt-2">
            You'll need your password to sign back in. If this is your own
            phone, there's usually no need to sign out at all — just close the app.
          </p>
          <button onClick={() => supabase.auth.signOut()}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold">
            Sign out
          </button>
          <button onClick={() => setConfirmingSignOut(false)}
            className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
      <nav className="fixed bottom-0 inset-x-0 bg-surface border-t border-line flex"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => onTab(k)}
            className={`relative flex-1 h-16 text-lg font-semibold ${
              tab === k || (k === 'more' && MORE.includes(tab) && !directTabKeys.has(tab))
              ? 'text-amber' : 'text-dim'}`}>
            {label}
            {k === 'more' && pendingCount > 0 && (
              <span className="absolute top-2 right-1/2 translate-x-4 min-w-[1.25rem] h-5 px-1
                                rounded-full bg-clay text-bg text-xs font-bold flex items-center justify-center">
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}
