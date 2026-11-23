// The words a supply line says about itself.
//
// Pure, because these sentences are arithmetic in disguise and the
// figures are what the Store Manager acts on: she reads "Store gave 48,
// 31 recorded used" against a shelf and decides whether to issue more
// or refuse. A sentence that disagrees with the number beside it would
// send her after the wrong department.
//
// Everything here is ALL TIME. The Entries list is windowed to 7, 30 or
// 90 days; the old row put those windowed flows next to an all-time
// balance, so the three numbers never reconciled and nobody could tell
// why. These do: gave - used - sent back is the balance.
//
// Nothing is imported here on purpose: today's date is passed in rather
// than read, so every sentence can be checked against a fixed day.

// Anything the balance holds that the three figures do not explain came
// from somewhere this does not name — a correction, a move between two
// departments. It is DERIVED from the balance rather than counted
// separately, so the sentence cannot contradict the number it explains,
// whatever else has touched the item.
export function supplyStory(f, have) {
  const got = Number(f?.received || 0)
  const used = Number(f?.used || 0)
  const back = Number(f?.returned || 0)
  const bits = [
    got > 0 ? `Store gave ${got}.` : 'The Store has never given any.',
    used > 0 ? `${used} recorded used.` : 'None recorded used.',
  ]
  if (back > 0) bits.push(`${back} sent back.`)
  const rest = Number(have || 0) - (got - used - back)
  if (Math.abs(rest) > 0.009) {
    bits.push(rest > 0
      ? `${rest} added by a correction.`
      : `${-rest} taken off by a correction.`)
  }
  return bits.join(' ')
}

// A balance below zero is not a quantity anybody can act on, so it is
// said as the complaint it is.
export const supplyShortfall = (have) =>
  `${-Number(have)} more recorded used than the Store ever gave.`

// How long since a department last recorded using something. The age is
// what decides whether to issue more, so it is spelled out rather than
// left as a date to subtract in your head.
export function sinceText(d, today) {
  if (!d) return null
  const day = new Date(d + 'T12:00:00')
  const days = Math.round((new Date(today + 'T12:00:00') - day) / 864e5)
  const when = day.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
  if (days <= 0) return 'Last recorded today.'
  return `Last recorded ${when}, ${days} day${days === 1 ? '' : 's'} ago.`
}
