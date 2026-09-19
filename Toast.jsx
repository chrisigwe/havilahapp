import { createContext, useCallback, useContext, useState } from 'react'

const Ctx = createContext(() => {})
export const useToast = () => useContext(Ctx)

export function ToastHost({ children }) {
  const [items, setItems] = useState([])
  const push = useCallback((message, tone = 'info') => {
    const id = crypto.randomUUID()
    setItems(l => [...l, { id, message, tone }])
    setTimeout(() => setItems(l => l.filter(t => t.id !== id)), tone === 'error' ? 6000 : 3000)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-24 inset-x-4 z-[80] space-y-2 pointer-events-none">
        {items.map(t => (
          <div key={t.id}
            className={`rounded-xl px-4 py-3 border text-center ${
              t.tone === 'error' ? 'bg-clay text-bg border-clay'
              : t.tone === 'success' ? 'bg-raise border-leaf text-leaf'
              : 'bg-raise border-line text-ink'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
