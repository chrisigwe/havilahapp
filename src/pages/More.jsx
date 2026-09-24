const OVERSIGHT_ROLES = ['manager', 'gm', 'admin']

const ITEMS = [
  { key: 'dailysales', label: 'Daily sales', hint: 'Any past day, by department',
    roles: ['auditor', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'roomboard', label: 'Rooms', hint: 'Who is checked in, who is due out, what is owed',
    roles: ['front_desk', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'credit',  label: 'Credit',  hint: 'Who owes what, and record repayments',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'recovery', label: 'Recovered debt', hint: 'Payments collected, who paid and who recovered it',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'count',   label: 'Stock count', hint: 'Count your stock at end of shift',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'catalog', label: 'Catalog', hint: 'Items, prices and what is active',
    roles: ['gm', 'admin'] },
  { key: 'variance', label: 'Variances', hint: 'Sales where collection did not match the goods sold',
    roles: ['storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'fix',     label: 'Corrections', hint: 'Fix a mistake from today or yesterday',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'staysettings', label: 'Settings', hint: 'Room rates and the over-stay charge default',
    roles: ['manager', 'gm', 'admin'] },
  // Sales/Store/Stock are direct tabs for every department-scoped
  // role already (storekeeper, bar, front_desk) — these three only
  // exist here for oversight roles, who have Daily Sales/Rooms/Credit
  // promoted to direct tabs instead.
  { key: 'sales', label: 'Sales', hint: 'Record a sale for any department',
    roles: OVERSIGHT_ROLES },
  { key: 'store', label: 'Store', hint: 'Receive stock and record transfers',
    roles: OVERSIGHT_ROLES },
  { key: 'stock', label: 'Stock', hint: 'Current stock on hand by department',
    roles: OVERSIGHT_ROLES },
]

export default function More({ boot, onGo, pendingCount = 0 }) {
  // dailysales/roomboard/credit are dedicated top-level tabs for
  // auditor/front_desk/oversight roles respectively, not More-menu
  // destinations for THEM — hidden here so each doesn't appear in two
  // places at once; every other role that has access still reaches
  // them through this menu
  const isOversight = OVERSIGHT_ROLES.includes(boot.staff.role)
  const allowed = ITEMS.filter(i =>
    i.roles.includes(boot.staff.role)
    && !(i.key === 'dailysales' && (boot.staff.role === 'auditor' || isOversight))
    && !(i.key === 'roomboard' && (boot.staff.role === 'front_desk' || isOversight))
    && !(i.key === 'credit' && isOversight))
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
    </div>
  )
}
