// Every name a file uses must be a name that exists.
//
// 19 November 2026, twice in one day. A block of helpers was deleted and
// took `sendStatement` with it; the same deletion took `openPayFor`, and
// that one survived a build, a full `npm run check` and a deploy before
// a guest's account refused to open. Vite does not resolve identifiers —
// a free name is assumed to be a global and left alone — so nothing in
// the pipeline had an opinion about it.
//
// check-handlers was written after the first one, and it is honest about
// its own limit: it only reads `onClick={bareName}`. `openPayFor` was
// called as `onClick={() => openPayFor(rows, k)}`, inside an arrow, so it
// never looked.
//
// This one does not pattern-match. It parses each file and asks Babel's
// scope analysis for the names that are referenced but bound nowhere —
// not by a declaration, not by a parameter, not by an import. Anything
// left over is either a real browser global (listed below) or a bug.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
const traverse = _traverse.default || _traverse

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.jsx') || p.endsWith('.js')) files.push(p)
  }
}
walk('src')

// What the browser and the language actually provide. A name that is
// not here and not declared is a mistake, so keep this list short and
// add to it only for things that genuinely come from the platform.
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'console', 'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob',
  'File', 'FileReader', 'URL', 'URLSearchParams', 'AbortController',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'caches',
  'alert', 'confirm', 'prompt', 'print', 'open', 'close',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Proxy', 'Reflect',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Intl', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'undefined', 'globalThis', 'structuredClone', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa',
  'Image', 'Audio', 'Event', 'CustomEvent', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'Notification', 'Worker',
  'TextEncoder', 'TextDecoder', 'ArrayBuffer', 'Uint8Array', 'DataView',
  'process', 'import', 'React',
  // replaced at build time by Vite's `define` (see vite.config.js)
  '__BUILD_ID__',
])

let bad = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  let ast
  try {
    ast = parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator'],
    })
  } catch (e) {
    console.error(`${file}: could not be parsed — ${e.message}`)
    bad++
    continue
  }
  traverse(ast, {
    Program(path) {
      for (const name of Object.keys(path.scope.globals)) {
        if (GLOBALS.has(name)) continue
        const node = path.scope.globals[name]
        const line = node?.loc?.start?.line ?? '?'
        console.error(`${file}:${line}  "${name}" is used but never declared or imported`)
        bad++
      }
    },
  })
}

if (bad) {
  console.error(`\n${bad} undefined name${bad === 1 ? '' : 's'}. ` +
    'Each one is a page that dies the moment that line runs.')
  process.exit(1)
}
console.log(`check-undefined: ${files.length} files, every name accounted for`)
