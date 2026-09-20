import { useEffect, useState } from 'react'
import { onUpdateAvailable } from '../lib/swUpdate'

export default function UpdateBanner() {
  const [ready, setReady] = useState(false)
  useEffect(() => onUpdateAvailable(() => setReady(true)), [])
  if (!ready) return null
  return (
    <button onClick={() => window.location.reload()}
      className="block w-full px-5 py-2 text-sm text-center bg-leaf text-bg font-semibold">
      A new version is ready — tap to update
    </button>
  )
}
