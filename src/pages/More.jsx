import { useState } from 'react'
import { tabsFor } from '../lib/tabs'
import { BUILD_ID, checkForNewVersion } from '../lib/swUpdate'
import { MANAGEMENT } from '../lib/roles'
// Was named OVERSIGHT_ROLES but has always been manager/gm/admin.
const OVERSIGHT_ROLES = MANAGEMENT

const ITEMS = [
  { key: 'dailysales', label: 'Daily sales', hint: 'Any past day, by department',
    roles: ['auditor', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'roomboard', label: 'Rooms', hint: 'Who is checked in, who is due out, what is owed',
    roles: ['front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'credit',  label: 'Credit',  hint: 'Who owes what, and record repayments',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'recovery', label: 'Recovered debt', hint: 'Payments collected, who paid and who recovered it',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  // Sales/Store/Stock are direct tabs for every department-scoped
  // role already (storekeeper, bar, front_desk) — these three only
  // exist here for oversight roles, who have Daily Sales/Rooms/Credit
  // promoted to direct tabs instead.
  { key: 'sales', label: 'Sales', hint: 'Record a sale for any department',
    roles: OVERSIGHT_ROLES },
  { key: 'store', label: 'Store', hint: 'Receive stock and record transfers',
    roles: OVERSIGHT_ROLES },
  { key: 'stock', label: 'Stock', hint: 'Current stock on hand by department',
    // Roles whose BAR no longer carries Stock reach it here instead:
    // the auditor (it left for History) and now bar/front_desk (it left
    // for Credit). Without this they would lose the stock view entirely.
    roles: [...OVERSIGHT_ROLES, 'auditor', 'bar', 'front_desk'] },
  { key: 'count',   label: 'Stock count', hint: 'Count your stock at end of shift',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'catalog', label: 'Catalog', hint: 'Items, prices and what is active',
    roles: ['gm', 'admin'] },
  { key: 'payroll', label: 'Payroll', hint: 'Staff, monthly run, contributions and savings',
    roles: ['gm', 'admin'] },
  { key: 'staffaccounts', label: 'Staff accounts', hint: 'Hand over a login, or switch one off',
    roles: ['gm', 'admin'] },
  { key: 'mypay', label: 'My pay', hint: 'Your pay slip for each finished month',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'tillchecks', label: 'Till checks', hint: 'Who matched their till at close, and who did not',
    roles: ['storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'variance', label: 'Variances', hint: 'Sales where collection did not match the goods sold',
    roles: ['storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'fix',     label: 'Corrections', hint: 'Fix a mistake from today or yesterday',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'staysettings', label: 'Settings', hint: 'Room rates and the over-stay charge default',
    roles: ['gm', 'admin'] },
]

// What a role sees under More (nothing already on its bottom bar). Shared
// with the laptop sidebar so the two can never disagree.
export function moreItemsFor(role, recordsSales = false, hasPay = false) {
  const onBar = new Set(tabsFor(role, { recordsSales }).map(([k]) => k))
  // "My pay" appears only for people whose login is linked to a payroll employee.
  return ITEMS.filter(i => i.roles.includes(role) && !onBar.has(i.key) && (i.key !== 'mypay' || hasPay))
}

export default function More({ boot, onGo, pendingCount = 0, hasPay = false }) {
  // dailysales/roomboard/credit are dedicated top-level tabs for
  // auditor/front_desk/oversight roles respectively, not More-menu
  // destinations for THEM — hidden here so each doesn't appear in two
  // places at once; every other role that has access still reaches
  // them through this menu
  // Anything already on this role's bar is hidden here, so nothing
  // appears twice. Derived from tabsFor() rather than a hand-kept list of
  // per-role exclusions, which is what let the auditor's Counts and
  // Variances show up in both places.
  const recordsSales = (boot.locations || []).some(l => l.is_sales_point && !l.is_store)
  const allowed = moreItemsFor(boot.staff.role, recordsSales, hasPay)
  return (
    <div className="px-5">
      <ul className="divide-y divide-line/60">
        {allowed.map(i => (
          <li key={i.key}>
            <button onClick={() => onGo(i.key)} className="w-full text-left py-4 flex items-center gap-3">
              <div className="flex-1">
                <div className="font-semibold text-lg">{i.label}</div>
                <div className="text-dim text-sm">
                  {i.key === 'count' && pendingCount > 0
                    ? `${pendingCount} awaiting your verification`
                    : i.hint}
                </div>
              </div>
              {i.key === 'count' && pendingCount > 0 && (
                <span className="min-w-[1.5rem] h-6 px-1.5 rounded-full bg-clay text-bg
                                  text-sm font-bold flex items-center justify-center">
                  {pendingCount}
                </span>
              )}
            </button>
          </li>
        ))}
        {!allowed.length && <li className="py-8 text-center text-dim">Nothing else here for your role.</li>}
      </ul>
      <VersionLine />
    </div>
  )
}

// Shows which build this phone is running and lets anyone check for a
// newer one on demand — the way to confirm a deployment has arrived.
function VersionLine() {
  const [msg, setMsg] = useState('')
  const built = /^\d+$/.test(BUILD_ID)
    ? new Date(Number(BUILD_ID)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'development'
  async function check() {
    setMsg('Checking…')
    const found = await checkForNewVersion()
    setMsg(found ? '' : 'You have the latest version.')
  }
  return (
    <div className="py-6 text-center text-dim text-sm">
      <div>Version built {built}</div>
      <button onClick={check} className="mt-2 underline">Check for updates</button>
      {msg && <div className="mt-1">{msg}</div>}
    </div>
  )
}
