#!/usr/bin/env node
// Values read before they exist.
//
// 18 October 2026. A useMemo on the Corrections page was written above
// the const it reads. useMemo runs its function DURING render, so the
// read happened before the declaration and React threw "Cannot access
// 'Ts' before initialization" — which takes the whole page down, not
// just that line. The lint being run at the time only checked for
// undefined globals and could never have seen it.
//
// A const or let read ABOVE its own declaration, in code that runs
// during render, is the fault. A reference inside an ordinary callback
// is fine: it runs later, by which time the value exists. A reference
// inside useMemo is NOT fine — useMemo calls its function immediately.
//
//   node tools/check-tdz.mjs            (exits 1 if any are found)
//   node tools/check-tdz.mjs <dir>      (used to test the check itself)
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

// Hooks whose function argument runs while the component renders.
const RUNS_NOW = new Set(['useMemo'])

const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod')
const isBlock = (n) => n && (n.type === 'BlockStatement' || n.type === 'Program'
  || n.type === 'StaticBlock')

const bound = (node, out = []) => {
  if (!node) return out
  if (node.type === 'Identifier') out.push(node.name)
  else if (node.type === 'ObjectPattern') node.properties.forEach(p =>
    bound(p.type === 'RestElement' ? p.argument : p.value, out))
  else if (node.type === 'ArrayPattern') node.elements.forEach(e => bound(e, out))
  else if (node.type === 'AssignmentPattern') bound(node.left, out)
  else if (node.type === 'RestElement') bound(node.argument, out)
  return out
}

// Names this block binds with const/let, and the position at which each
// becomes usable: the end of its own declarator.
const blockBindings = (block) => {
  const m = new Map()
  for (const st of block.body || []) {
    if (st.type === 'VariableDeclaration' && st.kind !== 'var') {
      for (const d of st.declarations) for (const name of bound(d.id)) {
        if (!m.has(name)) m.set(name, { readyAt: d.end, line: d.loc.start.line })
      }
    }
  }
  return m
}

const findings = []
const kids = (n) => Object.keys(n).filter(k =>
  k !== 'loc' && k !== 'start' && k !== 'end' && k !== 'range' && k !== '__now')

for (const file of files) {
  const code = readFileSync(file, 'utf8')
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true })
  } catch { continue }

  // Every block is checked against its OWN bindings only. A nested block
  // that re-declares the same name is skipped, so two `const url` in
  // different scopes never see each other.
  const checkBlock = (block) => {
    const binds = blockBindings(block)
    if (binds.size) {
      const scan = (n, immediate) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) { for (const c of n) scan(c, immediate); return }
        if (!n.type) return

        // Mark the function argument of useMemo as running right now.
        if (n.type === 'CallExpression' && n.callee.type === 'Identifier'
            && RUNS_NOW.has(n.callee.name) && isFn(n.arguments[0])) {
          n.arguments[0].__now = true
        }
        // A function body runs later unless it was marked above.
        if (isFn(n) && n !== block && !n.__now) {
          // its parameters can shadow, and its body is deferred anyway
          return
        }
        // A nested block that re-declares a name hides ours there.
        if (isBlock(n) && n !== block) {
          const inner = blockBindings(n)
          let hidden = false
          for (const name of binds.keys()) if (inner.has(name)) hidden = true
          if (hidden) return
        }

        if (n.type === 'Identifier' && immediate) {
          const b = binds.get(n.name)
          if (b && n.start < b.readyAt) {
            findings.push({ file: relative(ROOT, file), line: n.loc.start.line,
                            name: n.name, declaredLine: b.line })
          }
        }

        for (const k of kids(n)) {
          // names that are not value reads
          if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
              && k === 'property' && !n.computed) continue
          if ((n.type === 'ObjectProperty' || n.type === 'ObjectMethod')
              && k === 'key' && !n.computed) continue
          if (n.type === 'VariableDeclarator' && k === 'id') continue
          if (n.type === 'JSXAttribute' && k === 'name') continue
          if ((n.type === 'JSXOpeningElement' || n.type === 'JSXClosingElement')
              && k === 'name') continue
          if (n.type === 'JSXMemberExpression') continue
          scan(n[k], immediate)
        }
      }
      scan(block, true)
    }

    // then every block inside this one, on its own terms
    const deeper = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { for (const c of n) deeper(c); return }
      if (!n.type) return
      if (isBlock(n) && n !== block) { checkBlock(n); return }
      for (const k of kids(n)) deeper(n[k])
    }
    for (const st of block.body || []) deeper(st)
  }

  checkBlock(ast.program)
}

const seen = new Set()
const unique = findings.filter(f => {
  const k = `${f.file}:${f.line}:${f.name}`
  if (seen.has(k)) return false
  seen.add(k); return true
})

if (!unique.length) {
  console.log('No values read before they exist.')
  process.exit(0)
}
console.log('Read during render, above its own declaration:\n')
for (const f of unique) {
  console.log(`  ${f.file}:${f.line}  "${f.name}" is not declared until line ${f.declaredLine}`)
}
console.log(`\n${unique.length} to fix. Move the line below what it reads.`)
process.exit(1)
