// A PDF cannot draw every character, and when it is handed one it cannot
// draw it does not complain: jsPDF writes the whole string as two-byte
// UCS-2, the reader draws every other byte as a blank glyph, and the line
// comes out spaced apart at twice its measured width, running across the
// next column. That is how "Star (<naira>1,300 of <naira>1,300 already
// paid)" printed on top of the server's name on a real statement.
//
// Nothing about that fails loudly, so it is tested here instead: every
// string on its way to a page must be characters the font can draw, and
// no page content may ever hold a NUL byte, which is the signature of the
// two-byte path.
import { plain, accountStatementPdf, guestStatementPdf, receiptPdf } from '../src/lib/pdfSheet.js'

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok   ${name} -> ${JSON.stringify(got)}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }
}

const NAIRA = '₦'
const EMDASH = '—'

// ---- what the fold does ----
eq('the naira sign becomes NGN', plain(`${NAIRA}1,300`), 'NGN 1,300')
eq('and does not double the space', plain(`${NAIRA} 1,300`), 'NGN 1,300')
eq('an em dash becomes a hyphen', plain(`Room 7 ${EMDASH} 3 nights`), 'Room 7 - 3 nights')
eq('a curly apostrophe becomes a straight one', plain('Ben’s room'), "Ben's room")
eq('curly quotes become straight ones', plain('“no charge”'), '"no charge"')
eq('an ellipsis becomes three dots', plain('wait…'), 'wait...')
eq('a non-breaking space becomes a space', plain('NGN 5,000'), 'NGN 5,000')
eq('an accented name is left alone', plain('René Okonkwo'), 'René Okonkwo')
eq('an ordinary line is left alone', plain('Star (1,300 already paid)'), 'Star (1,300 already paid)')
eq('nothing at all does not throw', plain(null), '')
eq('a number survives', plain(5000), '5000')

// Whatever else arrives, nothing above 0xFF may get through: that is the
// exact threshold jsPDF switches encoding at (charCodeAt >> 8).
const odd = `${NAIRA}—‘’“”…• 中文😀€`
const highest = Math.max(...[...plain(odd)].map(c => c.charCodeAt(0)))
eq('nothing above 0xFF survives the fold', highest <= 0xff, true)

// ---- the real sheets, built the way the app builds them ----
// Every string here is one the app actually passes in today.
const nul = (doc) => {
  const pages = doc.internal.pages.filter(Boolean).flat().join('\n')
  return pages.includes('\u0000')
}

const statement = await accountStatementPdf({
  customerName: 'Chike Ifeadi', branchName: 'Awka', where: 'All departments',
  creditRows: [
    { date: '11-02', department: 'Open Bar', item: `Star (${NAIRA}1,300 of ${NAIRA}1,300 already paid)`,
      servedBy: 'Joseph', qty: 1, unit: 1300, amount: 0 },
    { date: '11-03', department: 'Restaurant', item: 'Nsala, semo and goatmeat', servedBy: '', qty: 2, unit: 9000, amount: 9000 },
  ],
  creditTotal: 9000,
  payments: [{ date: '11-04', method: 'Cash', where: '', takenBy: '', note: `paid at the desk ${EMDASH} part`, amount: 1300 }],
  paidTotal: 1300, balance: 9000,
})
eq('an account statement holds no two-byte text', nul(statement), false)

const guest = await guestStatementPdf({
  guestName: 'Sir Ben', branchName: 'Awka', roomNumber: '7',
  stayDates: '12 Nov to 15 Nov', nightsText: '3 nights',
  accommodationLabel: `Accommodation ${EMDASH} Room 7 · 3 nights @ ${NAIRA}18,000`,
  roomCharge: 54000,
  lines: [{ date: '11-13', description: 'Star', qty: 2, amount: 2600 }],
  freeLines: [{ date: '11-13', description: 'Water', qty: 1, amount: 500 }],
  payments: [{ method: 'POS', amount: 20000 }],
  departmentCredit: [{ name: 'Open Bar', balance: 2600 }],
  total: 56600, paid: 20000, balance: 36600,
})
eq('a guest statement holds no two-byte text', nul(guest), false)

const receipt = await receiptPdf({
  branchName: 'Awka', where: 'Open Bar', customerName: 'Walk-in', served: 'Nonso', when: '22 Nov 19:40',
  lines: [{ description: `Star ${EMDASH} cold`, qty: 2, amount: 2600 }],
  payments: [{ method: 'Cash', amount: 2600 }],
  total: 2600, paid: 2600,
})
eq('a receipt holds no two-byte text', nul(receipt), false)

// The control: this is the fault itself, so if jsPDF ever stops doing
// this the test above has stopped proving anything and should be read
// again rather than trusted.
const { jsPDF } = await import('jspdf')
const bare = new jsPDF({ unit: 'pt', format: 'a4' })
bare.setFont('helvetica', 'normal').setFontSize(9.5)
bare.text(`Star (${NAIRA}1,300 already paid)`, 44, 100)
eq('unfolded, jsPDF still writes two-byte text', nul(bare), true)

console.log(`\npdftext: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
