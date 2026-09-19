import { useEffect, useState } from 'react'
import { pendingCount, onPendingChange, flush } from '../lib/outbox'

export default function PendingBanner() {
  const [n, setN] = useState(pendingCount())
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const off = onPendingChange(setN)
    const on = () => { setOnline(true); flush() }
    const down = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', down)
    return () => { off(); window.removeEventListener('online', on); window.removeEventListener('offline', down) }
  }, [])
  if (!n && online) return null
  return (
    <div className={`px-5 py-2 text-sm text-center ${n ? 'bg-amber text-bg' : 'bg-raise text-dim'}`}>
      {n
        ? `${n} entr${n === 1 ? 'y' : 'ies'} waiting to send${online ? ' — sending…' : ' (offline)'}`
        : 'No connection — entries will be saved and sent when you are back online'}
    </div>
  )
}
