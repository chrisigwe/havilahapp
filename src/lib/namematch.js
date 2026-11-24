// WHETHER TWO WRITTEN NAMES ARE THE SAME PERSON.
//
// Chris, 24 November 2026: "101 Professor Casmin is supposed to be
// Prof. Casmir Unizik. Those mismatches are what I want to mitigate."
//
// The duplicate guard never fired on these, and normalisation shows
// why. normalizeCustomerName strips titles but keeps digits, so a
// stored "101 Professor Casmin" becomes "101 casmin" while the typed
// "Prof. Casmir Unizik" becomes "casmir unizik". The room number
// poisons every comparison, and casmin against casmir is one letter
// nothing was looking for. Same for "102 calistus" against
// "callistus", and "204 innocent" against "oko innocent afo".
//
// normalizeCustomerName itself is NOT touched: it mirrors a database
// function that decides uniqueness, and changing what counts as a
// duplicate there could collide rows that exist today. This is a
// separate, looser key used only for searching and warning.
import { normalizeCustomerName } from './customerName.js'

// Room numbers and other bare figures are not part of anybody's name,
// and neither is the word "room". Dropping the digits alone was not
// enough: "Room 101" and "Room 207" both reduce to the single token
// "room", which would have made them the same person -- and
// room-named accounts are precisely what this list is full of.
const NOT_A_NAME = new Set(['room', 'rm', 'rms', 'suite', 'apt', 'no', 'number'])
export function nameTokens(s) {
  return normalizeCustomerName(s).split(' ')
    .filter(t => t && !/^\d+$/.test(t) && !NOT_A_NAME.has(t))
}

// Levenshtein, abandoned as soon as it exceeds `max`. Bounded because
// the only question asked is "within one or two letters", and a full
// distance between two long names costs more than the answer is worth.
export function within(a, b, max) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (row[j] < best) best = row[j]
    }
    if (best > max) return false
    prev = row
  }
  return prev[b.length] <= max
}

// One word against another. Longer words are allowed more slack,
// because a longer word carries more evidence that it is the same one:
// "casmin"/"casmir" at one letter, "callistus"/"calistus" at one,
// "obiageli"/"obiagelli" at two. Short words get none -- "obi" and
// "oby" are different people often enough that guessing is worse than
// missing.
export function sameWord(a, b) {
  if (a === b) return true
  const n = Math.min(a.length, b.length)
  if (n < 4) return false
  if (n >= 4 && (a.startsWith(b) || b.startsWith(a))) return true
  return within(a, b, n >= 8 ? 2 : n >= 5 ? 1 : 0)
}

// Worth SHOWING in a list: any real word in common. Deliberately loose
// -- the cost of a wrong suggestion is one more line to read.
export function looksSimilar(a, b) {
  const x = nameTokens(a), y = nameTokens(b)
  if (!x.length || !y.length) return false
  return x.some(t => t.length >= 4 && y.some(u => sameWord(t, u)))
}

// A staff account is a different KIND of record, and the branch names
// them so: "Casmir (staff)", "Manager (staff)". Chris, 24 November
// 2026: "Casmir (staff) is a staff not Prof Casmir Unizik" -- two men
// who share a first name, and this had them as one, because
// normalisation strips the "(staff)" that was the whole distinction.
//
// Only the WARNING cares. A barman typing "Casmir" should still be
// shown the staff account, because staff buy things; what must not
// happen is the app insisting the two records are one person and
// refusing to let a new one be made.
const STAFF_TAG = /\(\s*staff\s*\)/i
export const isStaffAccount = (s) => STAFF_TAG.test(String(s || ''))

// Worth WARNING about: every word of the shorter name is present in the
// longer one, and the two are the same kind of record. Stricter on purpose, because this is what stops somebody
// creating a record -- and blocking a real new customer because they
// share a first name with an existing one is worse than the duplicate
// it would prevent. "Emeka Obi" and "Emeka Nwosu" are two people.
export function probablySame(a, b) {
  if (isStaffAccount(a) !== isStaffAccount(b)) return false
  const x = nameTokens(a), y = nameTokens(b)
  if (!x.length || !y.length) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.every(t => long.some(u => sameWord(t, u)))
}

// For ordering a suggestion list: the best single answer first.
export function nameScore(typed, name) {
  const t = normalizeCustomerName(typed), n = normalizeCustomerName(name)
  if (!t) return 0
  if (t === n) return 100
  if (probablySame(typed, name)) return 80
  if (n.includes(t) || t.includes(n)) return 60
  if (looksSimilar(typed, name)) return 40
  return 0
}
