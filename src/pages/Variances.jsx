import { useCallback, useEffect, useMemo, useState } from 'react'
import { lagosDaysAgo, lagosToday, naira } from '../lib/format'
import { loadVariances } from '../lib/data'
import Notice from '../components/Notice'

export default function Variances({ boot }) {
  const { staff } = boot
  const [rows, setRows] = useState(null)
  // A failed load used to leave rows at null forever, so the page sat on
  // "Loading…" and read as a slow connection rather than a fault — and a
  // page about money that cannot load is exactly the one that must say
  // so (19 October 2026).
  const [err, setErr] = useState(null)
  const [who, setWho] = useState(null)        // a person's name, or null for everyone
  const [openDays, setOpenDays] = useState(null)

  const refresh = useCallback(() => {
    loadVariances(staff.branch_id)
      .then(r => { setRows(r); setErr(null) })
      .catch(e => setErr(e.message || 'could not load'))
  }, [staff.branch_id])
  useEffect(refresh, [refresh])

  // Who the differences belong to. This is the question the page exists
  // to answer and it was not on the page at all — every row named a
  // person, and nothing added them up.
  const byPerson = useMemo(() => {
    const m = new Map()
    for (const r of rows || []) {
      const k = r.recorded_by_name || 'unknown'
      const cur = m.get(k) || { name: k, n: 0, total: 0 }
      cur.n += 1
      cur.total += Number(r.difference || 0)
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  }, [rows])

  const shown = useMemo(() =>
    who ? (rows || []).filter(r => (r.recorded_by_name || 'unknown') === who) : (rows || []),
    [rows, who])

  // By day, newest open. Thirty days of sales in one unbroken list gave
  // no sense of whether this was one bad afternoon or a steady leak.
  const days = useMemo(() => {
    const m = new Map()
    for (const r of shown) {
      const k = r.business_date || '—'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [shown])

  const dayOpen = (d, first) => openDays ? openDays.has(d) : d === first
  const toggleDay = (d, first) => setOpenDays(cur => {
    const next = cur ? new Set(cur) : new Set(first ? [first] : [])
    if (next.has(d)) next.delete(d); else next.add(d)
    return next
  })
  const dayLabel = (d) =>
    d === lagosToday() ? 'Today'
    : d === lagosDaysAgo(1) ? 'Yesterday'
    : new Date(d + 'T12:00:00').toLocaleDateString('en-NG',
        { weekday: 'long', day: 'numeric', month: 'long' })

  if (err) {
    return (
      <div className="px-5">
        <Notice tone="problem" title="Variances could not be loaded" className="mt-4">
          <p>This is not the same as there being none. Tell the GM.</p>
          <p className="text-xs mt-2 break-words">{err}</p>
        </Notice>
      </div>
    )
  }
  if (!rows) return <p className="px-5 text-dim">Loading…</p>

  const total = shown.reduce((s, r) => s + Number(r.difference), 0)
  const short = shown.filter(r => Number(r.difference) > 0)
  const over = shown.filter(r => Number(r.difference) < 0)

  return (
    <div className="px-5 pb-8">
      {!rows.length ? (
        <>
          <p className="text-dim text-sm py-2">
            Sales where what was collected does not match the value of goods sold.
            Last 30 days.
          </p>
          <p className="py-10 text-center text-leaf font-semibold">
            Every sale is fully accounted for.
          </p>
        </>
      ) : (
      <>
      {/* The figure, then what it is made of. Short and over are not the
          same fault and were added into one number: money missing and
          money over-collected cancel each other out, so a day with
          ₦5,000 short and ₦5,000 over read as nothing wrong at all. */}
      <section className="rounded-2xl border border-clay bg-surface p-4 mt-3">
        <div className="text-dim text-sm">
          Unaccounted across {shown.length} {shown.length === 1 ? 'sale' : 'sales'}
          {who && <> · {who}</>}
        </div>
        <div className="tnum text-3xl font-bold text-clay">{naira(total)}</div>
        <div className="mt-3 pt-3 border-t border-line space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-dim min-w-0">
              Short — collected less than the goods were worth ({short.length})
            </span>
            <span className="tnum font-bold text-clay shrink-0">
              {naira(short.reduce((s, r) => s + Number(r.difference), 0))}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-dim min-w-0">
              Over — collected more than the goods were worth ({over.length})
            </span>
            <span className="tnum font-bold text-amber shrink-0">
              {naira(Math.abs(over.reduce((s, r) => s + Number(r.difference), 0)))}
            </span>
          </div>
        </div>
        <p className="text-dim text-xs mt-3">
          Last 30 days. A difference is not by itself a wrong-doing — a split
          payment keyed in the wrong order looks the same as money kept. Ask
          before concluding.
        </p>
      </section>

      {/* Whose they are. Tap a name to see only that person's. */}
      {byPerson.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-3 -mx-1 px-1">
          <button onClick={() => setWho(null)}
            className={`shrink-0 h-11 px-4 rounded-full border text-sm ${!who
              ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
            Everyone
          </button>
          {byPerson.map(p => (
            <button key={p.name} onClick={() => setWho(who === p.name ? null : p.name)}
              className={`shrink-0 h-11 px-4 rounded-full border text-sm inline-flex items-center gap-1.5 ${
                who === p.name ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              <span>{p.name}</span>
              <b className={`tnum ${who === p.name ? 'text-bg' : 'text-clay'}`}>{naira(p.total)}</b>
            </button>
          ))}
        </div>
      )}

      {days.map(([day, list]) => {
        const first = days[0][0]
        const open = dayOpen(day, first)
        const dayTotal = list.reduce((s, r) => s + Number(r.difference), 0)
        return (
          <section key={day} className="mt-3 rounded-2xl border border-line bg-surface">
            <button type="button" onClick={() => toggleDay(day, first)} aria-expanded={open}
              className="w-full px-4 py-3 flex items-baseline justify-between gap-3 text-left">
              <span className="min-w-0">
                <span className="font-semibold">{dayLabel(day)}</span>
                <span className="text-dim text-sm block">
                  {list.length} {list.length === 1 ? 'sale' : 'sales'}
                </span>
              </span>
              <span className="flex items-baseline gap-2 shrink-0">
                <span className={`tnum font-bold ${dayTotal > 0 ? 'text-clay' : 'text-amber'}`}>
                  {naira(dayTotal)}
                </span>
                <svg viewBox="0 0 20 20" className={`w-4 h-4 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
                     fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            {open && (
              <ul className="px-4 pb-1 border-t border-line divide-y divide-line/60">
                {list.map(r => (
                  <li key={r.sale_id} className="py-3">
                    <div className="flex items-baseline gap-3">
                      <span className="flex-1 min-w-0 font-semibold break-words">{r.item_name}</span>
                      <span className={`tnum font-bold shrink-0 ${
                        Number(r.difference) > 0 ? 'text-clay' : 'text-amber'}`}>
                        {naira(r.difference)}
                      </span>
                    </div>
                    <div className="text-dim text-sm">
                      {r.qty} × {naira(r.unit_price)} · {r.recorded_by_name || 'unknown'}
                    </div>
                    {/* Rows, not a single line of three figures. At 320px
                        "expected / allocated / difference" ran off the
                        edge and the numbers wrapped into each other. */}
                    <div className="mt-1 space-y-0.5 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-dim">Goods were worth</span>
                        <span className="tnum shrink-0">{naira(r.expected)}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-dim">Payment recorded</span>
                        <span className="tnum shrink-0">{naira(r.allocated)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      {!shown.length && (
        <p className="py-8 text-center text-dim">
          Nothing unaccounted for {who}.
        </p>
      )}
      </>
      )}
    </div>
  )
}
