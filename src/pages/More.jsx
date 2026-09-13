const ITEMS = [
  { key: 'credit',  label: 'Credit',  hint: 'Who owes what, and record repayments',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'recovery', label: 'Recovered debt', hint: 'Payments collected, who paid and who recovered it',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'count',   label: 'Stock count', hint: 'Count your stock at end of shift',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin', 'auditor'] },
  { key: 'catalog', label: 'Catalog', hint: 'Items, prices and what is active',
    roles: ['gm', 'admin'] },
  { key: 'variance', label: 'Variances', hint: 'Sales where collection did not match the goods sold',
    roles: ['storekeeper', 'manager', 'gm', 'admin'] },
  { key: 'fix',     label: 'Corrections', hint: 'Fix a mistake from today or yesterday',
    roles: ['bar', 'front_desk', 'storekeeper', 'manager', 'gm', 'admin'] },
]

export default function More({ boot, onGo, pendingCount = 0 }) {
  const allowed = ITEMS.filter(i => i.roles.includes(boot.staff.role))
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
