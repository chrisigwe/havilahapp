// Minimal stroke icons for the bottom nav — kept as one small file
// rather than pulling in an icon library for a handful of glyphs. All use
// currentColor so they pick up the active/inactive text color for
// free from the button around them.
const PATHS = {
  dailysales: <path d="M4 20V10M12 20V4M20 20v-7" />,
  roomboard: <path d="M4 19v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 19h16M4 19v-2M20 19v-2M4 12V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3" />,
  credit: <path d="M3 8h18M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM6 15h4" />,
  sales: <path d="M6 8V6a3 3 0 0 1 6 0v2M4 8h8l1 12H3L4 8Z" />,
  store: <path d="M4 8l1-4h6l1 4M4 8h8M4 8v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8M15 21V11h6v10a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1ZM15 13h6" />,
  stock: <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1ZM6 6h12v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6ZM9 11h6M9 15h6" />,
  // Checklist with ticks: counting items off and signing them off.
  // Deliberately NOT a clipboard — Stock already is one, and the two sit
  // side by side on the store manager's bar.
  count: <path d="M4 6.5l1.5 1.5L8 5M4 12.5l1.5 1.5L8 11M4 18.5l1.5 1.5L8 17M11 6.5h9M11 12.5h9M11 18.5h9" />,
  // Balance scale: what the system says against what was actually found.
  variance: <path d="M12 5v15M8 20h8M5 7h14M5 7l-2.5 6M5 7l2.5 6M2.5 13a2.5 2 0 0 0 5 0M19 7l-2.5 6M19 7l2.5 6M16.5 13a2.5 2 0 0 0 5 0" />,
  // Clock with a turn-back arrow: looking back over past edits (Corrections,
  // shown to auditors as History).
  fix: <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3v4h4M12 8v4l2.5 2.5" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
}


// FILLED versions for the selected tab. WhatsApp's bar switches the
// chosen icon from a hollow outline to a solid shape, which is what
// separates it from the rest at a glance — more legible than colour
// alone, and it still reads on a small or dim screen.
//
// Drawn as solid shapes with fill=currentColor rather than thickened
// strokes: a heavier outline just looks blurry at 20px.
const FILLED = {
  dailysales: <path d="M3 19h2.5a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1Zm7.75 0h2.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-2.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Zm7.75 0H21a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-2.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1Z" />,
  roomboard: <path d="M3 10.5V7a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2h4a4 4 0 0 1 4 4v1H3v-3.5ZM2 16h20v3a1 1 0 0 1-1 1h-1v-1H4v1H3a1 1 0 0 1-1-1v-3Z" />,
  credit: <path d="M2 9h20V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2Zm0 2.5V17a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.5H2ZM5.5 14h4a1 1 0 1 1 0 2h-4a1 1 0 1 1 0-2Z" />,
  sales: <path d="M8.5 6a2.5 2.5 0 0 1 5 0v1h-5V6ZM6.5 7V6a4.5 4.5 0 1 1 9 0v1h1.6a1 1 0 0 1 1 .9l1.1 11.9a1 1 0 0 1-1 1.1H3.8a1 1 0 0 1-1-1.1L3.9 7.9a1 1 0 0 1 1-.9h1.6Z" />,
  store: <path d="M4.2 3h7.6l1.1 4.4A2.6 2.6 0 0 1 8 8.7 2.6 2.6 0 0 1 3.1 7.4L4.2 3ZM4 10.3V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-8.7a4.6 4.6 0 0 1-4 .9 4.6 4.6 0 0 1-4-.9ZM14 10h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm1.5 3.5h4a.9.9 0 1 0 0-1.8h-4a.9.9 0 1 0 0 1.8Z" />,
  stock: <path d="M9 3h6a2 2 0 0 1 2 2v1H7V5a2 2 0 0 1 2-2ZM5 8h14a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1Zm4 3.5a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9Zm0 4a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H9Z" />,
  count: <path d="M11 5.5h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2Zm0 6h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2Zm0 6h10a1 1 0 1 1 0 2H11a1 1 0 1 1 0-2ZM7.3 3.9a1 1 0 0 1 1.5 1.3L6 8.6a1 1 0 0 1-1.5.1L2.9 7.1a1 1 0 0 1 1.4-1.4l.9.9 2.1-2.7Zm0 6a1 1 0 0 1 1.5 1.3L6 14.6a1 1 0 0 1-1.5.1l-1.6-1.6a1 1 0 0 1 1.4-1.4l.9.9 2.1-2.7Zm0 6a1 1 0 0 1 1.5 1.3L6 20.6a1 1 0 0 1-1.5.1l-1.6-1.6a1 1 0 0 1 1.4-1.4l.9.9 2.1-2.7Z" />,
  variance: <path d="M13 4a1 1 0 1 0-2 0v1.6L5.4 6.7a1 1 0 0 0 .2 2l.3-.1 2 4.8a1 1 0 0 0 .1.2 3.5 3.5 0 0 0 6.9-.9 1 1 0 0 0-.1-.4l-2-4.7 2.2-.4 2 4.8a1 1 0 0 0 .1.2 3.5 3.5 0 0 0 6.9-.9 1 1 0 0 0-.1-.4l-2.1-5 .2-.1a1 1 0 1 0-.4-2L13 5.6V4Zm-2 3.5v12H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-12l-2 .4ZM5.9 10.3l1 2.4H4.9l1-2.4Zm12.3-2.5 1 2.4h-2l1-2.4Z" />,
  fix: <path d="M12 3a9 9 0 1 0 8.5 12 1 1 0 1 0-1.9-.6A7 7 0 1 1 12 5a7 7 0 0 1 5 2.1H14.5a1 1 0 0 0 0 2h4.6a1 1 0 0 0 1-1V3.5a1 1 0 1 0-2 0v1.4A9 9 0 0 0 12 3Zm0 4a1 1 0 0 1 1 1v3.6l2.2 2.2a1 1 0 0 1-1.4 1.4l-2.5-2.5a1 1 0 0 1-.3-.7V8a1 1 0 0 1 1-1Z" />,
  more: <path d="M6.5 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm7.5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm7.5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />,
}

export default function NavIcon({ tab, className, filled = false }) {
  if (filled && FILLED[tab]) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className}>
        {FILLED[tab]}
      </svg>
    )
  }
  const path = PATHS[tab]
  if (!path) return null
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  )
}
