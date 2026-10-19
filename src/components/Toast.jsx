import { createContext, useCallback, useContext, useState } from 'react'

const Ctx = createContext(() => {})
export const useToast = () => useContext(Ctx)

export function ToastHost({ children }) {
  const [items, setItems] = useState([])
  // Optional third argument { duration } for messages that must be read,
  // e.g. "sent for approval". Every existing call keeps its old timing.
  const push = useCallback((message, tone = 'info', opts = {}) => {
    const id = crypto.randomUUID()
    setItems(l => [...l, { id, message, tone }])
    const ms = opts.duration ?? (tone === 'error' ? 6000 : 3000)
    setTimeout(() => setItems(l => l.filter(t => t.id !== id)), ms)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-24 inset-x-4 z-[80] space-y-2 pointer-events-none">
        {/* The same four tones as Notice, so a message that appears
            for a moment looks like the one that stays on the page
            (19 October 2026). An error was a solid clay block with the
            text knocked out of it — loud, and hard to read at the exact
            moment someone needs to read it carefully. It is now a dark
            card with a clay edge and an icon, like everything else. */}
        {items.map(t => {
          const tone = t.tone === 'error' ? 'problem'
            : t.tone === 'success' ? 'good' : 'note'
          const skin = tone === 'problem' ? 'border-clay/40 border-l-clay bg-surface'
            : tone === 'good' ? 'border-leaf/40 border-l-leaf bg-surface'
            : 'border-line border-l-line bg-surface'
          const ink = tone === 'problem' ? 'text-clay'
            : tone === 'good' ? 'text-leaf' : 'text-dim'
          return (
            <div key={t.id} role={tone === 'problem' ? 'alert' : 'status'}
              className={`rounded-2xl border border-l-4 ${skin} px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.45)]
                          flex gap-3 items-start`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"
                className={`w-5 h-5 shrink-0 mt-0.5 ${ink}`}
                fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                {tone === 'problem'
                  ? <path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  : tone === 'good'
                    ? <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>
                    : <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8.5v.01" /></>}
              </svg>
              <span className="min-w-0 text-ink text-sm text-left">{t.message}</span>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}
