// Folding a list into months. Kept free of imports so the checks in tools/
// can run it without a browser.
//
// The rule that matters: nobody is ever dropped. A row with no date still
// gets a group, because a debtor with a missing date is exactly the row
// somebody needs to see, not the one to quietly leave out.

export const UNDATED = 'undated'

// rows -> [{ key, rows }], newest month first, undated last.
export function monthBuckets(rows, dateOf) {
  const byKey = new Map()
  for (const r of rows || []) {
    const d = dateOf(r)
    const key = (typeof d === 'string' && d.length >= 7) ? d.slice(0, 7) : UNDATED
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }
  return [...byKey.keys()]
    .sort((a, b) => a === UNDATED ? 1 : b === UNDATED ? -1 : b.localeCompare(a))
    .map(key => ({ key, rows: byKey.get(key) }))
}

export function monthLabel(key) {
  if (key === UNDATED) return 'No start date recorded'
  return new Date(key + '-01T12:00:00')
    .toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })
}
