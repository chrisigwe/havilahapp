import { useMemo, useState } from 'react'
import { naira } from '../lib/format'

import { normalizeCustomerName as nameKey } from '../lib/customerName'

export default function CustomerPicker({ customers, value, onPick, onCreate }) {
  const [q, setQ] = useState('')
  const [servedBy, setServedBy] = useState('')

  const key = nameKey(q)
  const matches = useMemo(() => {
    if (!key) return customers.slice(0, 8)
    return customers.filter(c => nameKey(c.name).includes(key) || key.includes(nameKey(c.name)))
      .slice(0, 8)
  }, [customers, key])

  const exact = customers.find(c => nameKey(c.name) === key)
  const chosen = customers.find(c => c.id === value)

  if (chosen) {
    return (
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-amber bg-surface px-4 h-14">
        <span className="flex-1 font-semibold truncate">{chosen.name}</span>
        <button onClick={() => onPick(null)} className="text-dim">Change</button>
      </div>
    )
  }

  return (
    <div className="mt-2">
      <input value={q} onChange={e => setQ(e.target.value)}
        placeholder="Type the customer's name"
        className="h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />

      {!!matches.length && (
        <ul className="mt-2 rounded-xl border border-line bg-surface divide-y divide-line/60">
          {matches.map(c => (
            <li key={c.id}>
              <button onClick={() => onPick(c.id)} className="w-full text-left px-4 py-3">
                <span className="font-semibold">{c.name}</span>
                {c.balance > 0 && (
                  <span className="text-clay text-sm tnum ml-2">owes {naira(c.balance)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {key && exact && (
        <p className="mt-2 text-leaf text-sm">
          {exact.name} is already on file — tap it above rather than adding a second record.
        </p>
      )}

      {key && !exact && (
        <div className="mt-3">
          {!!matches.length && (
            <p className="text-amber text-sm mb-2">
              Check the list first — if this is the same person, tap their name.
              A second record would split their debt in two.
            </p>
          )}
          <input value={servedBy} onChange={e => setServedBy(e.target.value)}
            placeholder="Served by (optional) — do not put this in the name"
            className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
          <button onClick={() => onCreate(q.trim(), servedBy.trim())}
            className="mt-2 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
            Add "{q.trim()}" as a new customer
          </button>
        </div>
      )}
    </div>
  )
}
