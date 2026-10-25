// Guest statements, receipts and account statements as a REAL PDF file.
//
// Why not the browser's print: on a phone the app runs from the home screen,
// where iOS has no print screen at all and Chrome's shell has none either —
// the button did nothing. Printing a copy of the web page in a new tab worked
// no better: the app's own screen styling came with it, so the sheet came out
// distorted, and "Save as PDF" from an about:blank tab often saves nothing.
//
// So we draw the sheet ourselves, from the same figures the screen uses, and
// hand the phone a finished PDF: share sheet first (iOS saves to Files or
// sends it to the guest on WhatsApp), then an ordinary download, and as a last
// resort the file opens in a tab so it can be saved from there.

// Loaded only when someone actually asks for a PDF, so the app itself stays
// small and quick to open on a phone.
let jsPDF = null
async function loadPdfEngine() {
  if (!jsPDF) ({ jsPDF } = await import('jspdf'))
  return jsPDF
}

const A4 = { w: 595.28, h: 841.89 }   // points
const M = 44                          // page margin
const INK = [17, 17, 17]
const SOFT = [95, 95, 95]
const RULE = [170, 170, 170]

// Inside tables the column heading carries the currency, so the figures stay
// plain and never wrap onto a second line in a narrow column. The headline
// balance spells it out.
const num = (n) => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (n) => 'NGN ' + num(n)

// Everything is drawn through this little cursor so page breaks happen in one
// place: any block that will not fit starts a new page instead of being cut.
class Sheet {
  constructor(title) {
    this.doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true })
    this.doc.setProperties({ title })
    this.y = M
    this.page = 1
    this.title = title
  }
  get width() { return A4.w - M * 2 }
  room(h) {
    if (this.y + h <= A4.h - M - 24) return
    this.footer()
    this.doc.addPage()
    this.page += 1
    this.y = M
  }
  footer() {
    const d = this.doc
    d.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...SOFT)
    d.text(this.title, M, A4.h - 28)
    d.text(`Page ${this.page}`, A4.w - M, A4.h - 28, { align: 'right' })
    d.setTextColor(...INK)
  }
  gap(h) { this.y += h }

  heading(text, size = 11) {
    this.room(size + 12)
    this.doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(...INK)
    this.doc.text(text, M, this.y + size)
    this.y += size + 8
  }

  rule(weight = 0.6, color = RULE) {
    this.doc.setDrawColor(...color).setLineWidth(weight)
    this.doc.line(M, this.y, A4.w - M, this.y)
    this.y += 1
  }

  // Letterhead: business, branch, document name and a reference number.
  head({ business, subtitle, ref }) {
    const d = this.doc
    d.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...INK)
    d.text(business, M, this.y + 18)
    if (ref) {
      d.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...SOFT)
      d.text(ref, A4.w - M, this.y + 18, { align: 'right' })
    }
    this.y += 26
    d.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...SOFT)
    d.text(subtitle, M, this.y + 10)
    this.y += 18
    this.rule(1.2, INK)
    this.y += 14
    d.setTextColor(...INK)
  }

  // Two columns of label/value lines: who the sheet is for, and when it was made.
  meta(left = [], right = []) {
    const d = this.doc
    const colW = this.width / 2 - 10
    const draw = (rows, x, align) => {
      let y = this.y
      for (const [label, value, big] of rows) {
        if (label) {
          d.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...SOFT)
          d.text(label, x, y + 8, { align })
          y += 12
        }
        d.setFont('helvetica', big ? 'bold' : 'normal').setFontSize(big ? 13 : 10).setTextColor(...INK)
        for (const line of d.splitTextToSize(String(value ?? ''), colW)) {
          d.text(line, x, y + (big ? 11 : 9), { align })
          y += big ? 16 : 13
        }
        y += 4
      }
      return y
    }
    const a = draw(left, M, 'left')
    const b = draw(right, A4.w - M, 'right')
    this.y = Math.max(a, b) + 6
  }

  // A table. cols: [{ label, align, w }] with w as a share of the width.
  table(cols, rows, foot = []) {
    const d = this.doc
    const total = cols.reduce((s, c) => s + c.w, 0)
    const widths = cols.map(c => (c.w / total) * this.width)
    const x = (i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0)
    const cellX = (i) => cols[i].align === 'right' ? x(i) + widths[i] : x(i) + 4

    const header = () => {
      this.room(26)
      d.setFillColor(238, 238, 238)
      d.rect(M, this.y, this.width, 20, 'F')
      d.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...INK)
      cols.forEach((c, i) => d.text(c.label, cellX(i) - (c.align === 'right' ? 4 : 0), this.y + 14,
        { align: c.align === 'right' ? 'right' : 'left' }))
      this.y += 20
    }
    header()

    for (const row of rows) {
      const cells = cols.map((c, i) => d.setFont('helvetica', row.bold ? 'bold' : 'normal').setFontSize(9.5)
        && d.splitTextToSize(String(row.cells[i] ?? ''), widths[i] - 8))
      const h = Math.max(...cells.map(c => c.length)) * 12 + 8
      if (this.y + h > A4.h - M - 30) { this.footer(); d.addPage(); this.page += 1; this.y = M; header() }
      d.setTextColor(...(row.soft ? SOFT : INK))
      cells.forEach((lines, i) => {
        d.setFont('helvetica', row.bold ? 'bold' : 'normal').setFontSize(9.5)
        lines.forEach((line, k) => d.text(line, cellX(i) - (cols[i].align === 'right' ? 4 : 0),
          this.y + 12 + k * 12, { align: cols[i].align === 'right' ? 'right' : 'left' }))
      })
      this.y += h
      d.setDrawColor(222, 222, 222).setLineWidth(0.5)
      d.line(M, this.y, A4.w - M, this.y)
      d.setTextColor(...INK)
    }

    if (foot.length) {
      this.room(foot.length * 16 + 8)
      d.setDrawColor(...INK).setLineWidth(1)
      d.line(M, this.y, A4.w - M, this.y)
      this.y += 2
      for (const f of foot) {
        d.setFont('helvetica', f.bold ? 'bold' : 'normal').setFontSize(f.bold ? 10.5 : 9.5).setTextColor(...INK)
        d.text(f.label, x(cols.length - 1) - 12, this.y + 12, { align: 'right' })
        d.text(f.value, A4.w - M - 4, this.y + 12, { align: 'right' })
        this.y += 16
      }
    }
    this.y += 10
  }

  // The headline figure, boxed so it is the first thing anyone looks at.
  balance(label, value) {
    this.room(42)
    const d = this.doc
    d.setDrawColor(...INK).setLineWidth(1.4)
    d.line(M, this.y, A4.w - M, this.y)
    this.y += 6
    d.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...INK)
    d.text(label, M, this.y + 16)
    d.text(value, A4.w - M, this.y + 16, { align: 'right' })
    this.y += 30
  }

  // Small label/amount list, e.g. "Included above — other departments".
  lines(title, rows) {
    if (!rows?.length) return
    this.room(rows.length * 14 + 28)
    const d = this.doc
    d.setDrawColor(...RULE).setLineWidth(0.5)
    d.line(M, this.y, A4.w - M, this.y)
    this.y += 10
    d.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(...INK)
    d.text(title, M, this.y + 8)
    this.y += 16
    for (const [l, r] of rows) {
      d.setFont('helvetica', 'normal').setFontSize(9.5)
      d.text(String(l), M, this.y + 8)
      d.text(String(r), A4.w - M, this.y + 8, { align: 'right' })
      this.y += 14
    }
    this.y += 6
  }

  note(text) {
    this.room(40)
    const d = this.doc
    d.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...SOFT)
    for (const line of d.splitTextToSize(text, this.width)) {
      d.text(line, M, this.y + 9)
      this.y += 12
    }
    this.y += 6
    d.setTextColor(...INK)
  }

  finish() { this.footer(); return this.doc }
}

const stamp = () => new Date().toLocaleString('en-NG', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})

// Date wide enough for "2026-10-01 14:20", amount for the largest figure,
// and the rest to the description so an ordinary line does not wrap.
const COLS = [
  { label: 'Date', align: 'left', w: 17 },
  { label: 'Description', align: 'left', w: 62 },
  { label: 'Amount (NGN)', align: 'right', w: 21 },
]

// ---------- the guest's stay statement ----------
export async function guestStatementPdf(d) {
  await loadPdfEngine()
  const s = new Sheet(`Guest statement — ${d.guestName || 'Guest'}`)
  s.head({
    business: 'Havilah Suite Ltd',
    subtitle: `${d.branchName || ''} · Guest Statement`,
    ref: d.ref ? `No. ${d.ref}` : '',
  })
  s.meta(
    [['Guest', d.guestName || 'Guest', true],
     ['', [`Room ${d.roomNumber ?? '—'}`, d.stayDates, d.nightsText].filter(Boolean).join(' · ')]],
    [['Printed', stamp()]],
  )

  const rows = [{ cells: [d.checkInLabel || '', d.accommodationLabel || 'Accommodation', num(d.roomCharge)] }]
  if (Number(d.overstay) > 0) rows.push({ cells: ['', 'Over-stay charge', num(d.overstay)] })
  for (const li of d.orderLines || []) {
    // Served by, on the line itself rather than a column of its own:
    // the charge column has the room for it and a sixth narrow column
    // would truncate the item names (Chris, 25 October 2026).
    const served = li.servedName ? `  ·  served by ${li.servedName}` : ''
    rows.push({ cells: [li.date || '', `${li.description} x ${li.qty}  ·  ${li.where}${served}`, num(li.amount)] })
  }
  s.table(COLS, rows, [
    { label: 'Room and over-stay', value: num(Number(d.roomCharge) + Number(d.overstay || 0)) },
    { label: 'Food, drinks and minimart', value: num(d.orderTotal) },
    { label: 'Total charges', value: num(d.totalDue), bold: true },
  ])

  if (d.freeLines?.length) {
    s.heading('Complimentary / not charged')
    s.table(
      [COLS[0], { label: 'Item', align: 'left', w: 62 }, { label: 'Value (NGN)', align: 'right', w: 21 }],
      d.freeLines.map(li => ({ soft: true, cells: [li.date || '', `${li.description} x ${li.qty}`, `${num(li.amount)} — no charge`] })),
    )
  }

  if (d.payments?.length) {
    s.heading('Payments received')
    s.table(
      [COLS[0], { label: 'Method', align: 'left', w: 62 }, { label: 'Amount (NGN)', align: 'right', w: 21 }],
      d.payments.map(p => ({ cells: [p.date || '', p.method, num(p.amount)] })),
      [{ label: 'Total paid', value: num(d.paid), bold: true }],
    )
  }

  s.balance(Number(d.balance) > 0 ? 'Balance due' : 'Balance', money(Math.abs(Number(d.balance) || 0)))
  s.lines('Included above — other departments:', (d.departmentCredit || []).map(x => [x.name, money(x.balance)]))
  s.lines('Rooms billed to this guest:', (d.billedToYou || []).map(x => [x.name, x.label || money(x.amount)]))
  s.gap(10)
  s.note('Thank you for staying with us.')
  s.gap(14)
  s.note('Received by _______________________________')
  return s.finish()
}

// ---------- a credit customer's statement of account ----------
export async function accountStatementPdf(d) {
  await loadPdfEngine()
  const s = new Sheet(`Statement — ${d.customerName || 'Account'}`)
  s.head({ business: 'Havilah Suite Ltd', subtitle: `${d.branchName || ''}${d.where ? ` · ${d.where}` : ''} · Statement of Account` })
  s.meta([['Account', d.customerName || 'Account', true]], [['Date', stamp()]])

  // Served by / Taken by, as columns of their own (Chris, 25 October
  // 2026). Widths re-cut from the existing ones rather than added to:
  // they total 100 and a column past that is silently clipped.
  s.heading('Goods taken on credit')
  s.table(
    [{ label: 'Date', align: 'left', w: 10 }, { label: 'Department', align: 'left', w: 14 },
     { label: 'Item', align: 'left', w: 25 }, { label: 'Served by', align: 'left', w: 16 },
     { label: 'Qty', align: 'right', w: 6 },
     { label: 'Unit (NGN)', align: 'right', w: 13 }, { label: 'Amount (NGN)', align: 'right', w: 16 }],
    (d.creditRows || []).map(r => ({
      cells: [r.date, r.department, r.item, r.servedBy || '—', String(r.qty), num(r.unit), num(r.amount)] })),
    [{ label: 'Total credit', value: num(d.creditTotal), bold: true }],
  )

  s.heading('Payments received')
  s.table(
    [{ label: 'Date', align: 'left', w: 12 }, { label: 'Method', align: 'left', w: 18 },
     { label: 'Taken by', align: 'left', w: 20 },
     { label: 'Note', align: 'left', w: 28 }, { label: 'Amount (NGN)', align: 'right', w: 22 }],
    (d.payments || []).map(r => ({ cells: [r.date, r.method, r.takenBy || '—', r.note || '', num(r.amount)] })),
    [{ label: 'Total paid', value: num(d.paidTotal), bold: true }],
  )

  s.balance('Balance owing', money(d.balance))
  s.gap(4)
  s.note(d.footer || 'Prepared from the Havilah inventory system. Please settle at the front desk or with the store manager.')
  return s.finish()
}

// ---------- a sales receipt ----------
export async function receiptPdf(d) {
  await loadPdfEngine()
  const s = new Sheet('Receipt — Havilah Suite')
  s.head({ business: 'Havilah Suite Ltd', subtitle: `${d.branchName || ''}${d.where ? ` · ${d.where}` : ''} · Receipt` })
  s.meta([[d.customerName ? 'Customer' : '', d.customerName || '']].filter(r => r[1]),
    [['Served', [d.served, d.when].filter(Boolean).join(' · ')]])
  s.table(
    [{ label: 'Item', align: 'left', w: 56 }, { label: 'Qty', align: 'right', w: 14 }, { label: 'Amount (NGN)', align: 'right', w: 30 }],
    (d.lines || []).map(l => ({ cells: [l.description, String(l.qty), num(l.amount)] })),
    [{ label: 'Total', value: num(d.total), bold: true },
     ...(d.payments || []).map(p => ({ label: p.method, value: num(p.amount) }))],
  )
  s.gap(4)
  s.note('Thank you.')
  return s.finish()
}

// Hand the finished file to the phone: share sheet (Files, WhatsApp, Mail),
// then a plain download, then a tab it can be saved from.
export async function savePdf(docOrPromise, filename) {
  const doc = await docOrPromise
  const name = `${String(filename).replace(/[^\w .-]/g, '').trim() || 'statement'}.pdf`
  const blob = doc.output('blob')
  try {
    const file = new File([blob], name, { type: 'application/pdf' })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name })
      return 'shared'
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled'
  }
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 20000)
    return 'downloaded'
  } catch { /* fall through */ }
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  return 'opened'
}
