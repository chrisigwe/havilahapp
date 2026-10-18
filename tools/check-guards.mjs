#!/usr/bin/env node
// Refusals that cannot be answered from where they are shown.
//
// 18 October 2026. A sale dated to another day was refused inside the
// payment sheet — "say why this is going to Sat, 17 Oct" — while the
// only box for that reason sat on the page behind the sheet, covered by
// it. The person was told to do something they could not reach, and the
// sale could not be saved at all.
//
// The shape of the fault: a submit button inside an overlay, a guard
// that requires some state, and no control for that state inside the
// same overlay. This finds every instance of it.
//
//   node tools/check-guards.mjs            (exits 1 if any are found)
//
// It reads the code only. It never runs the app and changes nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'

// Defaults to this project's src; a path can be passed in, which is how
// the check is itself tested against a known-bad copy.
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

const findings = []

for (const file of files) {
  const code = readFileSync(file, 'utf8')
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true })
  } catch { continue }

  const src = (n) => code.slice(n.start, n.end)
  const setterOf = new Map()   // stateVar -> setter
  const varOfSetter = new Map()
  const guardsOf = new Map()   // function name -> Set(stateVar it demands)
  const inputsIn = new Map()   // containerId -> Set(stateVar it can set)
  const submits = []           // { containerId, fn, line, disabled }

  // A container is anything that COVERS the page: a <Sheet>, any
  // component whose name ends in Sheet, or a full-screen fixed overlay.
  // Everything else is the page itself, where a field is at least
  // reachable by scrolling.
  const containerName = (node) => {
    if (node.type !== 'JSXElement') return null
    const n = node.openingElement.name
    const name = n.type === 'JSXIdentifier' ? n.name : null
    if (name && /Sheet$/.test(name)) return name
    const cls = node.openingElement.attributes.find(a =>
      a.type === 'JSXAttribute' && a.name?.name === 'className')
    const text = cls && cls.value ? src(cls.value) : ''
    if (/fixed\s+inset-0/.test(text)) return name || 'overlay'
    return null
  }

  const walkNode = (node, stack) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const c of node) walkNode(c, stack); return }
    if (!node.type) return

    // const [x, setX] = useState(...)
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ArrayPattern'
        && node.init?.type === 'CallExpression'
        && src(node.init.callee) === 'useState'
        && node.id.elements.length === 2
        && node.id.elements[0]?.type === 'Identifier'
        && node.id.elements[1]?.type === 'Identifier') {
      setterOf.set(node.id.elements[0].name, node.id.elements[1].name)
      varOfSetter.set(node.id.elements[1].name, node.id.elements[0].name)
    }

    // A named function that refuses: if (<test>) { toast(…); return }
    if ((node.type === 'FunctionDeclaration' && node.id)
        || (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
            && (node.init?.type === 'ArrowFunctionExpression'
                || node.init?.type === 'FunctionExpression'))) {
      const name = node.id.name
      const body = node.type === 'FunctionDeclaration' ? node.body : node.init.body
      const demanded = new Set()
      const scan = (n) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) { for (const c of n) scan(c); return }
        if (n.type === 'IfStatement') {
          const text = src(n.consequent)
          // a refusal: it tells the person no, and stops
          if (/\breturn\b/.test(text) && /toast\(|alert\(|throw /.test(text)) {
            const test = src(n.test)
            for (const v of setterOf.keys()) {
              if (new RegExp(`\\b${v}\\b`).test(test)) demanded.add(v)
            }
          }
        }
        for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') scan(n[k])
      }
      scan(body)
      if (demanded.size) guardsOf.set(name, demanded)
    }

    const container = containerName(node)
    const stack2 = container ? [...stack, `${container}@${node.loc.start.line}`] : stack
    const here = stack2.length ? stack2[stack2.length - 1] : null

    if (node.type === 'JSXElement') {
      const nameNode = node.openingElement.name
      const tag = nameNode.type === 'JSXIdentifier' ? nameNode.name : ''
      const attrs = node.openingElement.attributes
      const attrText = (want) => {
        const a = attrs.find(x => x.type === 'JSXAttribute' && x.name?.name === want)
        return a && a.value ? src(a.value) : ''
      }

      // Anything the person can type or choose in.
      if (/^(input|textarea|select)$/.test(tag) || /Picker$|Field$/.test(tag)) {
        const text = attrText('onChange') + attrText('onPick') + attrText('onInput') + attrText('value')
        for (const [v, setter] of setterOf) {
          if (new RegExp(`\\b${setter}\\b`).test(text)
              || new RegExp(`\\bset${v[0].toUpperCase()}${v.slice(1)}\\b`).test(text)) {
            const key = here || '(page)'
            if (!inputsIn.has(key)) inputsIn.set(key, new Set())
            inputsIn.get(key).add(v)
          }
        }
      }

      // The button that commits.
      if (tag === 'button') {
        const click = attrText('onClick')
        const disabled = attrText('disabled')
        for (const fn of guardsOf.keys()) {
          if (new RegExp(`\\b${fn}\\b`).test(click)) {
            submits.push({ container: here, fn, line: node.loc.start.line, disabled })
          }
        }
      }
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      walkNode(node[k], stack2)
    }
  }
  walkNode(ast.program, [])

  for (const s of submits) {
    // Only an overlay can hide the field. On the open page it is at
    // worst further up, and scrolling reaches it.
    if (!s.container) continue
    const reachable = inputsIn.get(s.container) || new Set()
    for (const v of guardsOf.get(s.fn) || []) {
      if (reachable.has(v)) continue
      findings.push({
        file: relative(ROOT, file), line: s.line, container: s.container,
        fn: s.fn, missing: v,
        note: new RegExp(`\\b${v}\\b`).test(s.disabled)
          ? 'the button is disabled by it, with no way to fill it here'
          : 'it refuses here, with no way to fill it here',
      })
    }
  }
}

if (!findings.length) {
  console.log('No unanswerable refusals: every guard can be satisfied where it fires.')
  process.exit(0)
}
console.log('Refusals the person cannot answer from where they are:\n')
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}`)
  console.log(`    inside <${f.container.split('@')[0]}>, ${f.fn}() needs "${f.missing}" — ${f.note}`)
}
console.log(`\n${findings.length} to fix. Put the control in the same sheet as the refusal.`)
process.exit(1)
