export default function Logo({ className = '' }) {
  // Four-quadrant suite mark — several departments (rooms, bar,
  // restaurant, stock) held together as one suite, using the app's
  // full accent palette rather than a single amber tone. Colors are
  // baked in explicitly now, not currentColor — the original
  // single-tone boxes could inherit text-amber from their container,
  // but a four-color mark can't work that way, so callers no longer
  // need to (and shouldn't) pass a text-* color class.
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="16" y="16" width="13.5" height="13.5" rx="3" fill="#e8a13d" />
      <rect x="34.5" y="16" width="13.5" height="13.5" rx="3" fill="#7fb08a" />
      <rect x="16" y="34.5" width="13.5" height="13.5" rx="3" fill="#d96c5a" />
      <rect x="34.5" y="34.5" width="13.5" height="13.5" rx="3" fill="#e8a13d" />
    </svg>
  )
}
