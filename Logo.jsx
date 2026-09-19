export default function Logo({ className = '' }) {
  // Three stacked boxes — matches the app icon (inventory). Drawn in
  // currentColor so it inherits amber via `text-amber`, sitting on the
  // app's own dark background (the icon's amber tile would be
  // redundant here, so just the boxes).
  return (
    <svg viewBox="0 0 64 64" className={className} fill="currentColor" aria-hidden="true">
      <rect x="17.5" y="32" width="13" height="13" rx="2.5" />
      <rect x="33.5" y="32" width="13" height="13" rx="2.5" />
      <rect x="25.5" y="18" width="13" height="13" rx="2.5" />
    </svg>
  )
}
