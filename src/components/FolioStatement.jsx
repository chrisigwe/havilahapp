import { naira } from '../lib/format'

function printOnly(id) {
  document.querySelectorAll('.invoice-print').forEach(el => {
    el.style.display = el.id === id ? '' : 'none'
  })
  window.print()
  document.querySelectorAll('.invoice-print').forEach(el => { el.style.display = '' })
}

// A guest's printable stay statement — same invoice-print/.invoice-table
// infrastructure Receipt.jsx already uses, not the reference app's
// separate portal-based printing (which it needed only because of its
// own drawer nesting; this app doesn't have that problem).
export default function FolioStatement({ room, folio, orderLines, payments, branchName, departmentCredit, billedToYou, onClose }) {
  const roomCharge = Number(folio?.room_charge ?? 0)
  const overstay = Number(folio?.overstay_charge ?? 0)
  const orderTotal = orderLines.reduce((s, li) => s + Number(li.amount), 0)
  const paid = Number(folio?.total_paid ?? 0)
  const departmentCreditTotal = (departmentCredit || []).reduce((s, d) => s + Number(d.balance), 0)
  const billedToYouTotal = (billedToYou || []).reduce((s, b) => s + Number(b.outstanding), 0)
  // Per explicit correction, linked department credit and other
  // guests' bills billed to this guest both belong in the headline
  // balance, not just shown separately below it.
  const balance = roomCharge + overstay + orderTotal - paid + departmentCreditTotal + billedToYouTotal

  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="p-5 print:hidden">
          <button onClick={onClose} className="text-dim">Back</button>
        </div>

        <div id="folio-statement-area" className="invoice-print px-5 pb-6">
          <div className="invoice-head">
            <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
            <p className="text-dim">{branchName} · Guest Statement</p>
          </div>

          <div className="invoice-meta mt-5">
            <div>
              <div className="text-dim text-sm">Guest</div>
              <div className="text-xl font-bold">{room.guest_name || 'Guest'}</div>
              <div className="text-dim text-sm mt-1">
                Room {room.room_number} · {room.check_in_date} to {folio?.scheduled_out || room.scheduled_out}
                {folio?.nights ? ` · ${folio.nights} night${folio.nights > 1 ? 's' : ''}` : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="text-dim text-sm">Printed</div>
              <div className="tnum">
                {new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos',
                  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>

          <table className="invoice-table mt-6">
            <thead><tr><th>Charges</th><th className="num">Amount</th></tr></thead>
            <tbody>
              <tr>
                <td>{folio?.nights} night{folio?.nights > 1 ? 's' : ''} at {naira(folio?.daily_rate)}</td>
                <td className="num tnum">{naira(roomCharge)}</td>
              </tr>
              {overstay > 0 && (
                <tr><td>Over-stay charge</td><td className="num tnum">{naira(overstay)}</td></tr>
              )}
              {orderLines.map(li => (
                <tr key={li.id}>
                  <td>{li.description} <span className="text-dim">× {li.qty}</span></td>
                  <td className="num tnum">{naira(li.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="num font-bold">Total due</td>
                <td className="num tnum font-bold">{naira(roomCharge + overstay + orderTotal)}</td>
              </tr>
            </tfoot>
          </table>

          {payments.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 font-bold">Payments received</h3>
              <table className="invoice-table">
                <thead><tr><th>Date</th><th>Method</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td>{p.business_date}</td>
                      <td>{p.method.toUpperCase()}{p.is_overstay ? ' (over-stay)' : ''}</td>
                      <td className="num tnum">{naira(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="2" className="num font-bold">Total paid</td>
                    <td className="num tnum font-bold">{naira(paid)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}

          <div className="invoice-balance mt-6">
            <span>{balance > 0 ? 'Balance due' : 'Balance'}</span>
            <span className="tnum">{naira(Math.abs(balance))}</span>
          </div>

          {!!departmentCredit?.length && (
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid #ccc' }}>
              <p className="font-semibold text-sm">Included above — other departments:</p>
              {departmentCredit.map(d => (
                <div key={d.location_id} className="flex justify-between text-sm mt-1">
                  <span>{d.location_name}</span>
                  <span className="tnum">{naira(d.balance)}</span>
                </div>
              ))}
            </div>
          )}
          {!!billedToYou?.length && (
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid #ccc' }}>
              <p className="font-semibold text-sm">Included above — other bills:</p>
              {billedToYou.map(b => (
                <div key={b.stay_id} className="flex justify-between text-sm mt-1">
                  <span>{b.guest_name} (Room {b.room_number || '—'})</span>
                  <span className="tnum">{naira(b.outstanding)}</span>
                </div>
              ))}
            </div>
          )}

          <p className="text-dim text-sm mt-6 invoice-foot">
            Thank you for staying with us.<br />Received by _______________________
          </p>
        </div>
      </div>

      <div className="p-5 border-t border-line flex gap-3 print:hidden">
        <button onClick={onClose} className="flex-1 h-14 rounded-2xl border border-line font-bold">
          Close
        </button>
        <button onClick={() => printOnly('folio-statement-area')}
          className="flex-1 h-14 rounded-2xl bg-amber text-bg font-bold">Print / PDF</button>
      </div>
    </div>
  )
}
