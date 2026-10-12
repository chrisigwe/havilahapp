// Printing a sheet (guest statement, sales receipt) — phone included.
//
// window.print() is fine on a laptop, but it does nothing on a phone once
// the app has been added to the home screen: iOS WebKit has no print UI in
// standalone mode, and Chrome's home-screen shell has none either, so the
// "Print / PDF" button looked dead. Nothing was broken in the sheet itself.
//
// On a phone we therefore build a small self-contained copy of the sheet —
// the app's own stylesheets copied in, so it looks the same — and hand it to
// the real browser in a new tab, which does have Print / Save as PDF. If the
// browser blocks the tab, the copy is saved as a file instead, so the person
// always ends up holding the statement.

const onPhone = () => {
  try {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.navigator.standalone === true
    const small = window.matchMedia?.('(max-width: 1024px)')?.matches
    const touch = window.matchMedia?.('(pointer: coarse)')?.matches
    return !!(standalone || (small && touch))
  } catch { return false }
}

// Every rule the app itself is using. Same-origin, so readable; a sheet we
// cannot read (none, in practice) is skipped rather than failing the print.
const appStyles = () => {
  let out = ''
  for (const s of Array.from(document.styleSheets || [])) {
    try {
      for (const r of Array.from(s.cssRules || [])) out += r.cssText + '\n'
    } catch { /* cross-origin sheet — skip it */ }
  }
  return out
}

const escapeTitle = (t) => String(t).replace(/[<>&]/g, '')

export function printSheet(elementId, title = 'Havilah Suite') {
  const node = document.getElementById(elementId)
  if (!node) { window.print(); return }

  if (!onPhone()) { window.print(); return }

  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeTitle(title)}</title>
<style>${appStyles()}</style>
<style>
  /* On screen in the new tab, show it as it will print: ink on paper. */
  html, body { background: #fff !important; margin: 0; }
  .sheet { max-width: 820px; margin: 0 auto; }
  .invoice-print, .invoice-print * { color: #000 !important; background: transparent !important; }
  .invoice-print .text-dim { color: #555 !important; }
  .print\\:hidden { display: none !important; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 8px; padding: 10px 12px;
             background: #111; justify-content: flex-end; }
  .toolbar button { font: 600 15px/1 system-ui, sans-serif; color: #111; background: #f5c76a;
                    border: 0; border-radius: 10px; padding: 12px 16px; }
  @media print { .toolbar { display: none !important; } }
</style>
</head><body>
<div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">${node.innerHTML}</div>
<script>window.addEventListener('load', function () { setTimeout(function () { window.print() }, 400) })</script>
</body></html>`

  const win = window.open('', '_blank')
  if (win && win.document) {
    win.document.write(doc)
    win.document.close()
    try { win.focus() } catch { /* ignore */ }
    return
  }

  // New tab blocked: save it instead, so the statement is still in hand.
  try {
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${escapeTitle(title).replace(/[^\w -]/g, '') || 'statement'}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  } catch {
    window.print()
  }
}
