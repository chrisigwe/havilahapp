import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)

// Register the service worker so the app shell loads reliably and
// survives brief connection drops. It never caches live data (see
// sw.js) — Supabase calls always hit the network. Registered after
// load so it never delays first paint.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // registration failing is non-fatal — the app works without it,
      // just without offline shell caching
    })
  })
}
