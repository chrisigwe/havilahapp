// The real pairs from Awka's customer list, 24 November 2026. Each one
// is a person recorded twice because the app could not see that the two
// names were the same.
import { nameTokens, sameWord, looksSimilar, probablySame, nameScore, within } from '../src/lib/namematch.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }
}

eq('a room number is not part of a name',
   nameTokens('101 Professor Casmin').join(','), 'casmin')
eq('titles and punctuation go too',
   nameTokens('Prof. Casmir Unizik').join(','), 'casmir,unizik')
eq('a comma stuck to the number',
   nameTokens('102,pastor Calistus').join(','), 'calistus')
eq('a name with nothing but a room number has no tokens',
   nameTokens('Room 207').join(','), '')
// Dropping the digits alone left both of these as the single token
// "room", which made every room-named account the same person.
eq('two different rooms are not the same person',
   probablySame('Room 101', 'Room 207'), false)
eq('nor are they similar', looksSimilar('Room 101', 'Room 207'), false)
eq('a room-named account still matches on the name beside it',
   probablySame('Rm 207 Chibeke', 'Mr Chibeke Eze'), true)

// The three real duplicates.
eq('Casmin is Casmir', probablySame('101 Professor Casmin', 'Prof. Casmir Unizik'), true)
eq('Calistus is Callistus', probablySame('102,pastor Calistus', 'Pastor Callistus'), true)
eq('204 Mr Innocent is Mr Oko Innocent Afo', probablySame('204 Mr Innocent', 'Mr Oko Innocent Afo'), true)

// And the ones that must NOT be merged.
eq('two people sharing a first name are two people',
   probablySame('Emeka Obi', 'Emeka Nwosu'), false)
eq('but they are still worth showing in the list',
   looksSimilar('Emeka Obi', 'Emeka Nwosu'), true)
eq('three-letter names get no slack', sameWord('obi', 'oby'), false)
eq('a staff account is not the guest of the same name',
   probablySame('Casmir (staff)', 'Prof Casmir Unizik'), true)

eq('one letter in a six-letter word', sameWord('casmin', 'casmir'), true)
eq('one letter in a nine-letter word', sameWord('callistus', 'calistus'), true)
eq('two letters in a long word', sameWord('obiageli', 'obiagelli'), true)
eq('two letters in a short word', sameWord('kate', 'kite'), false)
eq('a prefix counts once it is long enough', sameWord('chidera', 'chid'), true)
eq('a three-letter prefix does not', sameWord('chidera', 'chi'), false)

eq('bounded distance stops early', within('abcdefgh', 'zzzzzzzz', 2), false)
eq('identical strings are within anything', within('abc', 'abc', 0), true)

// Ranking: the exact record first, the misspelling next, a shared first
// name last.
const typed = 'Casmir Unizik'
eq('exact wins', nameScore(typed, 'Prof. Casmir Unizik'), 100)
eq('the misspelt duplicate comes next', nameScore(typed, '101 Professor Casmin'), 80)
eq('an unrelated name scores nothing', nameScore(typed, 'Mrs Nkechi Obi'), 0)
eq('nothing typed scores nothing', nameScore('', 'Anybody'), 0)

// Must never throw on the junk that reaches it.
eq('null name', looksSimilar(null, 'Someone'), false)
eq('empty both', probablySame('', ''), false)
eq('digits only', looksSimilar('207', '101'), false)

console.log(`\nnamematch: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
