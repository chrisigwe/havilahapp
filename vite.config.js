import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Browsers only detect "a new service worker exists" by comparing
// sw.js's own bytes against what's already installed — but sw.js is
// a static file Vite copies unchanged into every build, so on a
// normal deploy its bytes never differ and the browser never sees
// anything new, no matter how much the app underneath changed. This
// stamps a real build timestamp into the cache name after every
// build, so sw.js is genuinely different every time, which is what
// actually makes update detection (and the "new version ready"
// banner) work at all.
function stampServiceWorker() {
  return {
    name: 'stamp-service-worker',
    writeBundle() {
      const path = resolve(__dirname, 'dist/sw.js')
      const stamped = readFileSync(path, 'utf8')
        .replace(/havilah-shell-v\d+/, `havilah-shell-${Date.now()}`)
      writeFileSync(path, stamped)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  // Without this, a crash in production only ever shows minified
  // names like "el" or "ns" — permanently undecodable. With it, the
  // exact same error shows the real file and line, because the
  // browser applies the map automatically.
  build: { sourcemap: true },
})
