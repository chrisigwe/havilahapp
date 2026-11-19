// Every onClick={something} must point at something that exists.
//
// 19 November 2026: a block of helpers was deleted and took
// `sendStatement` with it. The build was clean — Vite does not resolve
// identifiers — and every guard passed, because check-jsx-names only
// knows about COMPONENTS. The first person to tap "Send as text" got
// "sendStatement is not defined" and a dead screen.
//
// So: for each handler prop given a bare identifier, that identifier
// must be declared in the file or imported into it. Only bare names are
// checked — an inline arrow or a member expression is somebody else's
// problem.
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// Names JavaScript and the browser already provide.
const GLOBALS = new Set(['window', 'document', 'navigator', 'console', 'Math',
  'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Set', 'Map',
  'crypto', 'alert', 'confirm', 'print', 'undefined', 'null', 'true', 'false'])

let bad = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const declared = new Set(GLOBALS)
  // const/let/var/function/class names, including destructured ones
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // Destructuring, but ONLY where something is actually being declared.
  // A looser pattern matched `onClick={sendStatement}` itself and so
  // declared every handler to itself — the guard passed on the very bug
  // it was written for.
  const names = (inside) => {
    for (const part of inside.split(',')) {
      const m = part.match(/([A-Za-z_$][\w$]*)\s*$/) || part.match(/^\s*([A-Za-z_$][\w$]*)/)
      if (m) declared.add(m[1])
    }
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) names(m[1])
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) names(m[1])
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) names(m[1])
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) names(m[1])
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1])
  // imports
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(n[1])
  }
  // handler props given a bare identifier
  for (const m of src.matchAll(/\bon[A-Z][\w]*=\{([A-Za-z_$][\w$]*)\}/g)) {
    if (!declared.has(m[1])) {
      bad++
      const line = src.slice(0, m.index).split('\n').length
      console.log(`  ${file}:${line}  ${m[0]} — ${m[1]} is not declared in this file`)
    }
  }
}

if (bad) {
  console.log(`\n${bad} handler${bad === 1 ? '' : 's'} pointing at nothing. `
    + 'The build will not catch these; the first tap will.')
  process.exit(1)
}
console.log('Every handler points at something that exists.')
