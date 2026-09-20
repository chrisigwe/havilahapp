import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initServiceWorker } from './lib/swUpdate'
createRoot(document.getElementById('root')).render(<App />)

// Registered after load so it never delays first paint. See
// swUpdate.js for the full update-detection story — the service
// worker itself makes the app shell load reliably and survive brief
// connection drops, and never caches live data (Supabase calls
// always hit the network).
initServiceWorker()
