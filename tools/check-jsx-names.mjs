// Every capitalised JSX tag must be something this file can actually see.
//
// 27 October 2026: a "Move to another room" sheet was written as <Sheet>
// in a file that has no Sheet component and no import for one. The build
// says nothing — an undefined JSX tag is a runtime ReferenceError, and
// the first person to tap the button gets a blank folio.
//
// Deliberately dumb: it only asks whether the name appears in an import,
// a declaration, or a destructure in the same file. That is enough to
// catch the fault above and will not argue about anything subtler.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.jsx')) files.push(p)
  }
}
walk('src')

// Tags that are HTML, not components, despite the capital.
const HTML = new Set(['Fragment'])
const problems = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const used = new Set()
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)) used.add(m[1])
  for (const name of used) {
    if (HTML.has(name)) continue
    const declared =
      new RegExp(`\\bimport\\s+${name}\\b`).test(src) ||                    // default import
      // named import, with or without a default beside it:
      //   import { Notice } from ...
      //   import TillTile, { SubLine, ByMethod } from ...
      new RegExp(`\\bimport\\s+(?:[A-Za-z0-9_$]+\\s*,\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`, 's').test(src) ||
      new RegExp(`\\b(?:function|const|let|class)\\s+${name}\\b`).test(src) ||    // declared here
      new RegExp(`\\b${name}\\s*[:,}]`).test(src.split('\n').filter(l => /^\s*(const|let)\s*\{/.test(l)).join('\n'))
    if (!declared) problems.push({ file, name })
  }
}

if (!problems.length) {
  console.log('Every component on screen is one the file can see.')
  process.exit(0)
}
console.log('Components used but never imported or declared:\n')
for (const p of problems) console.log(`  ${p.file}\n    <${p.name}> — nothing in this file provides it`)
console.log(`\n${problems.length} to fix. These do not fail the build; they blank the page at runtime.`)
process.exit(1)
