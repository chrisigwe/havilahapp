// Who the bar needs to be told about before the next shift.
//
// Two different things end up on one list, and they clear in different
// ways. A customer OVER THE LIMIT is a number: it appears when they pass
// the branch limit and goes away by itself when they pay down under it,
// with nothing for anyone to remember to switch off. A customer CUT OFF
// is a decision Chris made about a person: it stays until he changes it,
// whatever the balance says, because "Chike gets nothing more" is not a
// figure.
//
// Pure and import-free so node can test it. The reason this list exists
// at all: staff serve drinks, write them on paper, and key them into the
// app the next morning. Nothing the app does at the save button can stop
// a drink that was poured last night — so the only use the app has is to
// tell them who is over BEFORE the next shift, while they are keying
// yesterday's paper with the names in front of them.
export function creditWatch({ customers, owed, limit }) {
  const cap = Number(limit)
  const hasCap = Number.isFinite(cap) && cap > 0
  const map = owed || {}
  return (customers || [])
    .map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone || null,
      owed: Number(map[c.id] || 0),
      cutOff: !!c.no_more_credit,
    }))
    // A cut-off customer is listed whatever they owe, including nothing:
    // the instruction is about them, not about their balance.
    .filter(r => r.cutOff || (hasCap && r.owed > cap))
    // Cut off first — that is the instruction, not the information —
    // then biggest debt down. Name breaks a tie so the order does not
    // shuffle between loads.
    .sort((a, b) =>
      (a.cutOff === b.cutOff ? 0 : a.cutOff ? -1 : 1)
      || b.owed - a.owed
      || String(a.name).localeCompare(String(b.name)))
}

// What the page says before anyone expands it. Written as a sentence
// rather than a count because "2" on its own is not a warning.
export function creditWatchLine(rows) {
  const list = rows || []
  if (!list.length) return null
  const cut = list.filter(r => r.cutOff).length
  const over = list.length - cut
  const parts = []
  if (cut) parts.push(`${cut} on no credit`)
  if (over) parts.push(`${over} past the limit`)
  return parts.join(', ')
}
