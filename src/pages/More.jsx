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

export default function More({ boot, onGo }) {
  const allowed = ITEMS.filter(i => i.roles.includes(boot.staff.role))
  return (
    <div className="px-5">
      <ul className="divide-y divide-line/60">
        {allowed.map(i => (
          <li key={i.key}>
            <button onClick={() => onGo(i.key)} className="w-full text-left py-4">
              <div className="font-semibold text-lg">{i.label}</div>
              <div className="text-dim text-sm">{i.hint}</div>
            </button>
          </li>
        ))}
        {!allowed.length && <li className="py-8 text-center text-dim">Nothing else here for your role.</li>}
      </ul>
    </div>
  )
}
