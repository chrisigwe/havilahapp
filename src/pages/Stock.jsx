import { useEffect, useMemo, useState } from 'react'
import { loadStockMap, loadRecentlyAdded } from '../lib/data'
import { OPENS_ON_ALL, is } from '../lib/roles'
import Notice from '../components/Notice'
import { tracked } from '../lib/loadfail'

export default function Stock({ boot }) {
  const { staff, locations, items, seesAll } = boot
  const [stockMap, setStockMap] = useState({})
  const [err, setErr] = useState(null)
  // Opens on the person's own department (their default), so a bartender
  // lands on their bar, not the whole branch. Auditor, GM and admin watch
  // everything, so they open on all, same rule as Recovery.
  const [locId, setLocId] = useState(() =>
    !is(staff.role, OPENS_ON_ALL) && staff.default_location_id
      && locations.some(l => l.id === staff.default_location_id)
      ? staff.default_location_id : 'all')
  // A branch switch can leave the chosen department behind: fall back to all.
  useEffect(() => {
    if (locId !== 'all' && !locations.some(l => l.id === locId)) setLocId('all')
  }, [locations, locId])
  const [q, setQ] = useState('')
  // Shape only — neither changes what is loaded.
  const [show, setShow] = useState('all')     // all | out | negative
  const [sort, setSort] = useState('name')    // name | lowest
  const [openItem, setOpenItem] = useState(null)

  // What arrived, and where (Chris, 24 October 2026). The page could say
  // what is on a shelf but never how it got there, so stock added to the
  // wrong department looked identical to stock that had always been
  // there — the only clue was a figure going below zero somewhere else.
  const [added, setAdded] = useState(null)
  const [addedErr, setAddedErr] = useState(null)
  useEffect(() => {
    if (show !== 'added') return
    setAdded(null); setAddedErr(null)
    tracked('What was recently added', loadRecentlyAdded(staff.branch_id, locId === 'all' ? null : locId, 30))
      .then(setAdded).catch(e => setAddedErr(e.message || 'could not load'))
  }, [show, locId, staff.branch_id])

  // Read-only for everyone. Auditors used to record PR/damage write-offs
  // here; removed in 255 — an auditor reviews write-offs and shouldn't
  // also be able to create them.

  // A failed load used to leave an empty list behind, which reads as
  // "there is no stock" — a claim, not an absence (19 October 2026).
  const refresh = () => {
    loadStockMap(staff.branch_id)
      .then(m => { setStockMap(m); setErr(null) })
      .catch(e => setErr(e.message || 'could not load'))
  }
  useEffect(refresh, [staff.branch_id])

  // Every item with where it sits, once. The list below, the counts on
  // the card and the breakdown inside a row all read this, so they
  // cannot disagree with each other.
  const all = useMemo(() => {
    return items.map(i => {
      const per = locations
        .map(l => ({ loc: l, qty: stockMap[`${i.id}:${l.id}`] ?? 0 }))
        .filter(p => p.qty !== 0)
      const total = per.reduce((s, p) => s + p.qty, 0)
      const shown = locId === 'all' ? total : (stockMap[`${i.id}:${locId}`] ?? 0)
      return { item: i, per, total, shown }
    })
  }, [items, locations, stockMap, locId])

  const needle = q.trim().toLowerCase()
  const inScope = useMemo(() => all
    .filter(r => r.shown !== 0 || needle)
    .filter(r => !needle || r.item.name.toLowerCase().includes(needle)),
    [all, needle])

  // Below zero is not a small stock level — it is the book saying
  // something impossible, which means a movement is missing or one was
  // recorded twice. It gets its own filter because it is the only thing
  // on this page that is always worth acting on.
  const negatives = inScope.filter(r => r.shown < 0)
  const zeroes = all.filter(r => r.shown === 0 && r.total !== 0)

  const rows = useMemo(() => {
    const base = show === 'negative' ? negatives
      : show === 'out' ? zeroes
      : inScope
    const sorted = [...base]
    if (sort === 'lowest') sorted.sort((a, b) => a.shown - b.shown
      || a.item.name.localeCompare(b.item.name))
    else sorted.sort((a, b) => a.item.name.localeCompare(b.item.name))
    return sorted
  }, [inScope, negatives, zeroes, show, sort])

  const units = inScope.reduce((s, r) => s + r.shown, 0)
  const placeName = locId === 'all'
    ? (seesAll ? 'everywhere' : 'your areas')
    : (locations.find(l => l.id === locId)?.name || 'here')

  if (err) {
    return (
      <div className="px-5">
        <Notice tone="problem" title="Stock could not be loaded" className="mt-4">
          <p>This is not an empty shelf — the figures did not arrive. Tell the GM.</p>
          <p className="text-xs mt-2 break-words">{err}</p>
        </Notice>
      </div>
    )
  }

  return (
    <div className="px-5 pb-8">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stock"
        className="w-full h-13 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
      <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1">
        <LocChip active={locId === 'all'} onClick={() => setLocId('all')}>
          {seesAll ? 'Everywhere' : 'My areas'}
        </LocChip>
        {/* Everywhere, then the Store, then the departments in their usual order */}
        {/* A place that no longer holds stock disappears from here — but
            NOT while it still has something on the book. Hiding a
            leftover figure is not the same as correcting it (572). */}
        {[...locations.filter(l => l.is_store), ...locations.filter(l => !l.is_store)]
          .filter(l => l.holds_stock !== false
            || all.some(r => (stockMap[`${r.item.id}:${l.id}`] ?? 0) !== 0))
          .map(l => (
            <LocChip key={l.id} active={locId === l.id} onClick={() => setLocId(l.id)}>{l.name}</LocChip>
          ))}
      </div>

      {/* What is actually on the page, before the page. It was a bare
          list: no count, no total, and nothing saying that a figure
          below zero is a fault rather than a small number. */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="text-dim text-sm">Stock {placeName}</div>
        <div className="tnum text-2xl font-bold">
          {units.toLocaleString('en-NG')} <span className="text-base font-semibold text-dim">units</span>
        </div>
        <div className="text-dim text-sm mt-1">
          across {inScope.length} {inScope.length === 1 ? 'item' : 'items'}
          {zeroes.length > 0 && <> · {zeroes.length} at zero</>}
        </div>
        {negatives.length > 0 && (
          <p className="text-clay text-sm mt-2 pt-2 border-t border-line">
            {negatives.length} {negatives.length === 1 ? 'item is' : 'items are'} below zero.
            That cannot happen on a shelf — it means a movement is missing, or one
            was recorded twice. Worth a count.
          </p>
        )}
      </section>

      {/* Scrollable rather than four equal buttons: at 320px "Below zero"
          and "Recently added" cannot both fit on a quarter of the width,
          and a clipped label is worse than a scroll. */}
      <div className="flex gap-2 mt-3 overflow-x-auto -mx-1 px-1 pb-1">
        {[['all', 'All'], ['added', 'Recently added'], ['out', 'At zero'], ['negative', 'Below zero']].map(([k, label]) => (
          <button key={k} onClick={() => setShow(k)}
            className={`shrink-0 h-10 px-4 rounded-xl border text-sm font-semibold ${show === k
              ? (k === 'negative' ? 'bg-raise border-clay text-clay' : 'bg-raise border-amber text-amber')
              : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      {show === 'added' ? (
        <AddedFeed rows={added} err={addedErr} locations={locations} locId={locId} />
      ) : (
      <>
      <div className="flex items-baseline justify-between mt-3">
        <p className="text-dim text-sm">
          {rows.length} {rows.length === 1 ? 'item' : 'items'}
        </p>
        <button onClick={() => setSort(s => s === 'name' ? 'lowest' : 'name')}
          className="text-amber text-sm font-semibold py-2 pl-3">
          {sort === 'name' ? 'Lowest first' : 'By name'}
        </button>
      </div>

      <ul className="mt-1 divide-y divide-line/60">
        {rows.map(({ item, shown, per, total }) => {
          // Everywhere adds up every counter into one number and says
          // nothing about where any of it is. A tap says where.
          const canOpen = locId === 'all' && per.length > 0
          const open = openItem === item.id
          return (
            <li key={item.id}>
              <button type="button" disabled={!canOpen}
                onClick={() => setOpenItem(open ? null : item.id)}
                className="w-full py-3 flex items-center gap-3 text-left">
                <span className="flex-1 min-w-0">
                  <span className="font-semibold break-words block">{item.name}</span>
                  {canOpen && (
                    <span className="text-dim text-xs">
                      {per.length} {per.length === 1 ? 'place' : 'places'}
                      {!open && ' · tap to see where'}
                    </span>
                  )}
                </span>
                <span className={`tnum font-bold shrink-0 ${shown < 0 ? 'text-clay'
                  : shown === 0 ? 'text-dim' : 'text-leaf'}`}>
                  {shown}
                </span>
              </button>
              {canOpen && open && (
                <div className="pb-3 pl-1 space-y-1">
                  {per.map(p => (
                    <div key={p.loc.id} className="flex justify-between gap-3 text-sm">
                      <span className="text-dim min-w-0 break-words">{p.loc.name}</span>
                      <span className={`tnum shrink-0 ${p.qty < 0 ? 'text-clay' : ''}`}>{p.qty}</span>
                    </div>
                  ))}
                  <div className="flex justify-between gap-3 text-sm pt-1 border-t border-line/60 font-semibold">
                    <span>Everywhere</span>
                    <span className="tnum">{total}</span>
                  </div>
                </div>
              )}
            </li>
          )
        })}
        {!rows.length && (
          <li className="py-8 text-center text-dim">
            {needle ? `Nothing matches “${q.trim()}”.`
              : show === 'negative' ? 'Nothing is below zero. Good.'
              : show === 'out' ? 'Nothing is at zero.'
              : 'Nothing here yet.'}
          </li>
        )}
      </ul>

      {/* Said once, at the bottom, where it answers the question a
          surprising figure raises rather than interrupting the list. */}
      <p className="text-dim text-xs mt-6">
        These are the figures the book holds right now, not as at any past day —
        anything recorded late is already counted in them.
      </p>
      </>
      )}
    </div>
  )
}

// How a movement reads in words. The type alone ("transfer") says
// nothing to the person looking for a mistake; where it came FROM is
// what makes a wrong department obvious.
const MOVE_WORDS = {
  restock: 'Received from a supplier',
  transfer: 'Moved in',
  issue: 'Issued',
  convert: 'Made here',
  adjustment: 'Adjusted',
  complimentary: 'Complimentary',
  damage: 'Damage',
  kitchen_use: 'Kitchen use',
  sale: 'Sale',
}

function AddedFeed({ rows, err, locations, locId }) {
  if (err) {
    return (
      <Notice tone="problem" title="What was added could not be loaded" className="mt-3">
        <p>This is not the same as nothing having been added. Tell the GM.</p>
        <p className="text-xs mt-2 break-words">{err}</p>
      </Notice>
    )
  }
  if (rows === null) return <p className="text-dim mt-4">Loading…</p>
  if (!rows.length) {
    return (
      <p className="py-8 text-center text-dim">
        Nothing has arrived {locId === 'all' ? 'anywhere' : 'here'} in the last 30 days.
      </p>
    )
  }
  const nameOf = (id) => (locations || []).find(l => l.id === id)?.name || null

  const days = []
  const seen = new Map()
  for (const r of rows) {
    let d = seen.get(r.business_date)
    if (!d) { d = { date: r.business_date, items: [] }; seen.set(r.business_date, d); days.push(d) }
    d.items.push(r)
  }

  return (
    <div className="mt-3">
      <p className="text-dim text-sm">
        Everything that arrived {locId === 'all' ? 'at any department' : 'here'} in the
        last 30 days, newest first.
      </p>
      {days.map(d => (
        <section key={d.date} className="mt-3">
          <h3 className="text-dim text-sm">
            {new Date(d.date + 'T12:00:00').toLocaleDateString('en-NG',
              { weekday: 'short', day: 'numeric', month: 'short' })}
          </h3>
          <ul className="mt-1 divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
            {d.items.map(r => {
              const to = nameOf(r.to_location)
              const from = nameOf(r.from_location)
              return (
                <li key={r.id} className="py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="flex-1 min-w-0 font-semibold break-words">
                      {r.stock_items?.name || 'Item'}
                    </span>
                    <span className="tnum font-bold text-leaf shrink-0">+{r.qty}</span>
                  </div>
                  <div className="text-dim text-sm break-words">
                    {MOVE_WORDS[r.movement_type] || r.movement_type}
                    {to ? ` into ${to}` : ''}
                    {from ? ` · from ${from}` : ''}
                  </div>
                  <div className="text-dim text-sm break-words">
                    {r.received_by
                      ? `Received by ${r.received_by}`
                      : 'Nobody named as receiving it'}
                    {r.staff?.full_name ? ` · recorded by ${r.staff.full_name}` : ''}
                  </div>
                  {r.note && <div className="text-dim text-xs break-words mt-0.5">{r.note}</div>}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <p className="text-dim text-xs mt-6">
        Arrived at the wrong department? Corrections → Entries can move it to the
        right one, or delete it.
      </p>
    </div>
  )
}

function LocChip({ active, onClick, children }) {
  return <button onClick={onClick}
    className={`shrink-0 h-11 px-4 rounded-full border ${active
      ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>{children}</button>
}
