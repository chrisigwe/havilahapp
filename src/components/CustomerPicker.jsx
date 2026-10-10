import { useEffect, useMemo, useRef, useState } from 'react'
import { naira } from '../lib/format'

import { normalizeCustomerName as nameKey } from '../lib/customerName'
import { findSimilarCustomers } from '../lib/data'

// "GM" and "General manager" are the same person, but no spelling test
// can see that. Compare the initials of a multi-word name with a short
// name (and the reverse): "general manager" -> "gm".
function initials(key) {
  const w = key.split(' ').filter(Boolean)
  return w.length > 1 ? w.map(x => x[0]).join('') : ''
}
function sameByInitials(a, b) {
  if (!a || !b || a === b) return false
  const ia = initials(a), ib = initials(b)
  return (!!ia && ia === b.replace(/ /g, '')) || (!!ib && ib === a.replace(/ /g, ''))
}

export default function CustomerPicker({ customers, value, onPick, onCreate, branchId, canOverride = false }) {
  const [q, setQ] = useState('')
  const [servedBy, setServedBy] = useState('')

  // The list above is filtered by "contains", which cannot catch a
  // misspelling: typing "Celeb" shows nothing even though "Caleb
  // (staff)" exists, and a second record gets made. This asks the
  // database for close names (migration 282) — reordered words, a
  // letter out, or written differently — and puts them in front of the
  // person BEFORE they create anything.
  const [similar, setSimilar] = useState([])
  const timer = useRef(null)
  useEffect(() => {
    if (!branchId || q.trim().length < 2) { setSimilar([]); return }
    clearTimeout(timer.current)
    // Waits for a pause in typing: one lookup, not one per keystroke.
    timer.current = setTimeout(() => {
      findSimilarCustomers(branchId, q).then(setSimilar).catch(() => setSimilar([]))
    }, 350)
    return () => clearTimeout(timer.current)
  }, [q, branchId])

  // Room-numbered accounts ("Room 207 Mr Obitex", "rm 207 Obitex") split a
  // guest's debt from their folio. The database now refuses them; this
  // explains why before anyone gets that far, and looks the guest up by
  // the name left once the room is taken out.
  const ROOM_RE = /\b(room|rm)\.?\s*\d+/ig
  const outside = q.replace(/\(.*?\)/g, ' ')
  const roomName = /\b(room|rm)\.?\s*\d+/i.test(outside) || /^\s*\d{3}\s*$/.test(q)
  const key = nameKey(roomName ? outside.replace(ROOM_RE, ' ') : q)
  const matches = useMemo(() => {
    if (!key) return customers.slice(0, 8)
    return customers.filter(c => nameKey(c.name).includes(key) || key.includes(nameKey(c.name)))
      .slice(0, 8)
  }, [customers, key])

  const exact = customers.find(c => nameKey(c.name) === key)
  // Names that are probably the SAME person: initials match, or the
  // database found a close spelling. Staff cannot add a new record
  // while one of these exists; the GM/admin can, after confirming.
  const strong = useMemo(() => {
    if (!key) return []
    const byInit = customers.filter(c => sameByInitials(nameKey(c.name), key))
    const ids = new Set(byInit.map(c => c.id))
    const bySim = similar.filter(x => !ids.has(x.id))
    return [...byInit.map(c => ({ ...c, reason: 'same initials' })), ...bySim]
  }, [customers, similar, key])
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

      {roomName && (
        <p className="mt-3 rounded-xl border border-clay p-3 text-clay text-sm">
          Do not put the room number in the name. Type the guest's own name and pick
          the account above. To bill a room guest, choose "In-house guest?" and charge their room.
        </p>
      )}

      {key && !exact && !roomName && (
        <div className="mt-3">
          {/* Close names the list above would not have shown. */}
          {!!strong.length && (
            <div className="mb-3 rounded-xl border border-clay bg-surface p-3">
              <p className="text-clay text-sm font-semibold">Did you mean one of these?</p>
              <p className="text-dim text-xs mb-2">
                A second record would split this person's debt in two.
              </p>
              {strong.map(x => (
                <button key={x.id} onClick={() => onPick(x.id)}
                  className="w-full flex items-center justify-between gap-2 h-11 px-3 mt-1
                             rounded-lg border border-amber text-left">
                  <span className="truncate">
                    <span className="text-amber font-semibold">{x.name}</span>
                    <span className="text-dim text-xs"> · {x.reason}</span>
                  </span>
                  <span className="tnum text-dim text-sm shrink-0">{x.balance != null ? naira(x.balance) : ''}</span>
                </button>
              ))}
            </div>
          )}

          {!!matches.length && (
            <p className="text-amber text-sm mb-2">
              Check the list first — if this is the same person, tap their name.
              A second record would split their debt in two.
            </p>
          )}
          <input value={servedBy} onChange={e => setServedBy(e.target.value)}
            placeholder="Served by (optional) — do not put this in the name"
            className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
          {strong.length > 0 && !canOverride ? (
            <p className="mt-2 rounded-xl border border-clay p-3 text-clay text-sm">
              This looks like someone already on file. Tap their name above.
              If it really is a different person, ask the GM or admin to add them.
            </p>
          ) : (
            <button onClick={() => onCreate(q.trim(), servedBy.trim())}
              className="mt-2 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
              {strong.length > 0 ? `Different person — add "${q.trim()}" anyway` : `Add "${q.trim()}" as a new customer`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
