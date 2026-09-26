// Minimal stroke icons for the bottom nav — kept as one small file
// rather than pulling in an icon library for six glyphs. All use
// currentColor so they pick up the active/inactive text color for
// free from the button around them.
const PATHS = {
  dailysales: <path d="M4 20V10M12 20V4M20 20v-7" />,
  roomboard: <path d="M4 19v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 19h16M4 19v-2M20 19v-2M4 12V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3" />,
  credit: <path d="M3 8h18M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM6 15h4" />,
  sales: <path d="M6 8V6a3 3 0 0 1 6 0v2M4 8h8l1 12H3L4 8Z" />,
  store: <path d="M4 8l1-4h6l1 4M4 8h8M4 8v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8M15 21V11h6v10a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1ZM15 13h6" />,
  stock: <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1ZM6 6h12v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6ZM9 11h6M9 15h6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
}

export default function NavIcon({ tab, className }) {
  const path = PATHS[tab]
  if (!path) return null
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  )
}
