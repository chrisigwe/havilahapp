// FOLDING A LONG LIST OF DAYS (Chris, 29 October 2026).
//
// Every day-grouped list in the app grew one row per day for ever.
// Corrections reaches back six months — a hundred and eighty headings
// to scroll past to reach March. A finished month does not need a row
// each; it needs one row that opens.
//
// The rule: the month in progress still shows its days, because that is
// the part anyone is actually working in. A month that has ended folds
// into one row. A year that has ended folds into one row of months.
//
// Pure: takes [day, items][] and returns nodes. No React, so it can be
// tested on its own and cannot drift between the screens that use it.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

// '2026-03' -> 'March 2026'
export function monthLabel(ym) {
  const [y, m] = String(ym).split('-')
  return `${MONTHS[Number(m) - 1] || m} ${y}`
}

export function foldDays(byDay, today) {
  const curMonth = String(today).slice(0, 7)
  const curYear = String(today).slice(0, 4)
  const loose = []
  const months = new Map()                 // '2026-09' -> day nodes
  const years = new Map()                  // '2025'    -> Map(ym -> day nodes)

  for (const [day, items] of (byDay || [])) {
    const d = String(day)
    const ym = d.slice(0, 7), y = d.slice(0, 4)
    const node = { kind: 'day', key: d, label: d, items }
    if (ym === curMonth) { loose.push(node); continue }
    if (y === curYear) {
      if (!months.has(ym)) months.set(ym, [])
      months.get(ym).push(node); continue
    }
    if (!years.has(y)) years.set(y, new Map())
    const mm = years.get(y)
    if (!mm.has(ym)) mm.set(ym, [])
    mm.get(ym).push(node)
  }

  const desc = (a, b) => String(b.key).localeCompare(String(a.key))
  const monthNode = (ym, kids) => ({
    kind: 'month', key: ym, label: monthLabel(ym),
    children: [...kids].sort(desc),
    days: kids.length,
    items: kids.flatMap(k => k.items),
  })

  const out = [...loose].sort(desc)
  out.push(...[...months.entries()].map(([ym, kids]) => monthNode(ym, kids)).sort(desc))
  out.push(...[...years.entries()].map(([y, mm]) => {
    const kids = [...mm.entries()].map(([ym, ds]) => monthNode(ym, ds)).sort(desc)
    return { kind: 'year', key: y, label: y, children: kids,
             days: kids.reduce((t, k) => t + k.days, 0),
             items: kids.flatMap(k => k.items) }
  }).sort(desc))
  return out
}
