// One item becoming a different item, in one place, at a ratio somebody
// decided: a bottle into shots, a crate into bottles, bottles of
// groundnut into plates.
//
// Pure and import-free so it can be tested from node, like payments.js
// and names.js. Both callers build their rows here — the storekeeper's
// Convert on the Store page and the bar's "open a bottle" on Sales — so
// the two cannot drift into writing conversions that read differently
// in the ledger.
//
// The invariant this file exists to protect: EXACTLY TWO legs, the
// first leaving (from_location set, to_location null) and the second
// arriving (the reverse), both at the SAME place on the SAME day. Get a
// direction wrong and stock moves the opposite way from what anyone
// intended, silently, and nobody finds out until a count.
export function conversionRows({ staff, fromItem, fromQty, toItem, toQty,
                                 locationId, date, note }) {
  const out = Number(fromQty)
  const back = Number(toQty)
  if (!staff?.id || !fromItem?.id || !toItem?.id || !locationId || !date) {
    throw new Error('A conversion needs who, what, where and when')
  }
  if (fromItem.id === toItem.id) {
    throw new Error('A conversion turns one item into a different one')
  }
  if (!(out > 0) || !(back > 0)) {
    throw new Error('Both sides of a conversion must be more than nothing')
  }
  const text = note
    || `Converted ${out} × ${fromItem.name} into ${back} × ${toItem.name}`
  // One timestamp for both legs: they are one act, and a ledger that
  // shows them a second apart invites someone to read them as two.
  const at = new Date().toISOString()
  const common = {
    branch_id: staff.branch_id,
    movement_type: 'conversion',
    business_date: date,
    occurred_at: at,
    recorded_by: staff.id,
    is_migrated: false,
    note: text,
  }
  return [
    { ...common, stock_item_id: fromItem.id, qty: out,
      from_location: locationId, to_location: null },
    { ...common, stock_item_id: toItem.id, qty: back,
      from_location: null, to_location: locationId },
  ]
}
