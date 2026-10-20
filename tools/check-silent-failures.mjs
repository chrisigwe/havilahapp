#!/usr/bin/env node
// Load failures that become "there is nothing here".
//
// The pattern, found six separate times between 18 and 20 October 2026:
// a request fails, its catch sets the state to an empty list, and the
// page then renders that emptiness as a statement about the business —
// "No staff accounts at this branch", "No activity recorded yet", "no
// items in the catalogue". Each one is the app asserting something it
// has no evidence for, on a screen somebody makes decisions from.
//
// This lists every catch that clears state to empty or null. Not all of
// them are wrong: a banner that simply does not appear is fine. The
// ones that matter are where the empty state is drawn as words.
//
//   node tools/check-silent-failures.mjs
//
// It never fails the build. It is an inventory to triage, not a rule.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'

const ROOT = process.argv[2] ? process.argv[2] : new URL('..', import.meta.url).pathname
const SRC = process.argv[2] ? process.argv[2] : join(ROOT, 'src')

const files = []
;(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.jsx?$/.test(p)) files.push(p)
  }
})(SRC)

const EMPTY = (node, src) => {
  if (!node) return false
  const t = src(node).trim()
  return t === '[]' || t === '{}' || t === 'null' || /^\{\s*\}$/.test(t)
}

const found = []

for (const file of files) {
  const code = readFileSync(file, 'utf8')
  let ast
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true }) }
  catch { continue }
  const src = (n) => code.slice(n.start, n.end)

  const walkNode = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const c of n) walkNode(c); return }
    if (!n.type) return

    // .catch(<fn>) — look inside the handler for a setter given an empty value
    if (n.type === 'CallExpression'
        && n.callee.type === 'MemberExpression'
        && !n.callee.computed
        && n.callee.property.name === 'catch'
        && n.arguments[0]) {
      const handler = n.arguments[0]
      const body = src(handler)
      const setters = [...body.matchAll(/\b(set[A-Z]\w*)\s*\(\s*(\[\]|\{\}|null)\s*\)/g)]
      for (const m of setters) {
        found.push({
          file: relative(ROOT, file),
          line: code.slice(0, n.start).split('\n').length,
          setter: m[1], value: m[2],
          // A catch is only silent if NOTHING tells the person. Three
          // things count: a toast, its own error state, or the load
          // being wrapped in tracked(), which puts the failure on the
          // strip at the top of the app (20 October 2026). The whole
          // statement is searched for tracked(), not just the handler,
          // because the wrap sits at the head of the chain.
          toasts: /toast\(/.test(body) || /setErr\w*\(/.test(body)
                  || /\btracked\s*\(/.test(src(n)),
        })
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      walkNode(n[k])
    }
  }
  walkNode(ast.program)
}

if (!found.length) {
  console.log('No load failure clears state to empty.')
  process.exit(0)
}

const byFile = new Map()
for (const f of found) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}

const silentOnly = found.filter(f => !f.toasts)
console.log(`${found.length} places where a failed load empties the screen:\n`)
for (const [file, list] of [...byFile.entries()].sort()) {
  console.log(`  ${file}`)
  for (const f of list) {
    console.log(`    line ${f.line}: ${f.setter}(${f.value})`
      + (f.toasts ? '  — says something' : '  — SILENT'))
  }
}
const silent = silentOnly.length
if (silent === 0) {
  console.log('\nEvery one of them says so. None reads as "there is nothing here".')
  process.exit(0)
}
console.log(`\n${silent} of them say nothing at all. Those are the ones that read`)
console.log('as "there is nothing here" when the truth is "this did not load".')
process.exitCode = 1
