import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initServiceWorker } from './lib/swUpdate'

// The crash screen itself is an inline script in index.html — it has to
// run before any module loads, or a module that throws on the way in
// leaves a black screen with no handler yet registered. This just hands
// it anything that gets past React's own ErrorBoundary inside App.
try {
  createRoot(document.getElementById('root')).render(<App />)
} catch (e) {
  window.__havilahFatal?.(e)
}

// Registered after load so it never delays first paint. See
// swUpdate.js for the full update-detection story — the service
// worker itself makes the app shell load reliably and survive brief
// connection drops, and never caches live data (Supabase calls
// always hit the network).
initServiceWorker()
