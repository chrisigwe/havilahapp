// What a refused write says about itself.
//
// A write that the server turns down is no longer thrown away with a
// line in the console nobody reads — it is shown to the person who made
// it, so they can key it again. Which means these sentences have to
// carry enough to re-enter the thing from: how much, how many, and
// which day. A card saying "a sale was refused" is barely better than
// losing it quietly.
//
// Nothing is imported here on purpose, so every sentence can be checked
// against a fixed payload.

const money = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })

const day = (d) => {
  if (!d) return null
  const t = new Date(String(d) + 'T12:00:00')
  return Number.isNaN(t.getTime()) ? null
    : t.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`

// The amount is worked out from the lines rather than read off the
// payment, because a basket can be part paid and part credit and it is
// the SALE that was refused, not the tender.
const basketTotal = (lines = []) =>
  lines.reduce((t, l) => t + Number(l.qty || 0) * Number(l.unitPrice || 0), 0)

export function describeJob(job) {
  const p = job?.payload || {}
  switch (job?.kind) {
    case 'basket': {
      const lines = p.lines || []
      const first = lines.find(l => l.item?.name || l.description)
      const name = first?.item?.name || first?.description
      const rest = lines.length - 1
      const what = lines.length === 1 && name ? name
        : name ? `${name} and ${count(rest, 'other item', 'other items')}`
        : count(lines.length, 'item', 'items')
      return `Sale of ${money(basketTotal(lines))} — ${what}${day(p.date) ? `, ${day(p.date)}` : ''}`
    }
    case 'repayment':
      return `Payment of ${money(p.amount)}${day(p.paidOn) ? `, ${day(p.paidOn)}` : ''}`
    case 'writeoff': {
      const kind = p.kind === 'damage' ? 'damaged' : 'given free'
      const name = p.itemName || 'an item'
      return `${p.qty} × ${name} recorded as ${kind}${day(p.date) ? `, ${day(p.date)}` : ''}`
    }
    case 'movements': {
      const rows = p.rows || []
      const d = day(rows[0]?.business_date)
      return `${count(rows.length, 'stock movement', 'stock movements')}${d ? `, ${d}` : ''}`
    }
    case 'countLine':
      return `A stock count entry of ${p.qty}`
    default:
      return 'An entry this version of the app does not recognise'
  }
}

// Why it was turned down. The server's own sentence is used wherever
// there is one, because it was written for the person reading it --
// "Match your Total Sales was done for that day, so it is closed" tells
// a barman what to do next in a way no generic wording can.
export function refusalReason(err) {
  const m = String(err || '').trim()
  if (!m) return 'The server refused it and gave no reason.'
  return m
}
