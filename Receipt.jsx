import { naira, tierLabel, methodLabel } from '../lib/format'

function printOnly(id) {
  document.querySelectorAll('.invoice-print').forEach(el => {
    el.style.display = el.id === id ? '' : 'none'
  })
  window.print()
  document.querySelectorAll('.invoice-print').forEach(el => { el.style.display = '' })
}

export default function Receipt({ lines, branchName, locById, onClose, onPrint }) {
  if (!lines?.length) return null

  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price), 0)
  const payments = {}
  for (const l of lines) {
    for (const p of (l.sale_payments || [])) {
      payments[p.method] = (payments[p.method] || 0) + Number(p.amount)
    }
  }
  const paid = Object.values(payments).reduce((s, v) => s + v, 0)
  const customer = lines.find(l => l.customers)?.customers
  const served = lines.find(l => l.staff)?.staff?.full_name
  const when = lines[0]?.created_at

  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="p-5 print:hidden">
          <button onClick={onClose} className="text-dim">Back</button>
        </div>

        <div id="receipt-area" className="invoice-print px-5 pb-6">
          <div className="invoice-head">
            <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
            <p className="text-dim">{branchName} · Sales Receipt</p>
          </div>

          <div className="invoice-meta mt-5">
            <div>
              {customer ? (
                <>
                  <div className="text-dim text-sm">Customer</div>
                  <div className="text-xl font-bold">{customer.name}</div>
                  {customer.phone && <div className="text-dim text-sm">{customer.phone}</div>}
                </>
              ) : (
                <>
                  <div className="text-dim text-sm">Customer</div>
                  <div className="text-xl">Walk-in</div>
                </>
              )}
              {served && <div className="text-dim text-sm mt-1">Served by {served}</div>}
            </div>
            <div className="text-right">
              <div className="text-dim text-sm">Date</div>
              <div className="tnum">
                {new Date(when || Date.now()).toLocaleString('en-NG', {
                  timeZone: 'Africa/Lagos', day: 'numeric', month: 'long',
                  year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>

          <table className="invoice-table mt-6">
            <thead>
              <tr>
                <th>Department</th><th>Item</th>
                <th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.id}>
                  <td>{locById?.[l.location_id]?.name || '—'}</td>
                  <td>
                    {l.stock_items?.name || l.description || '—'}
                    {l.tier && l.tier !== 'general' && (
                      <span className="text-dim"> ({tierLabel[l.tier] || l.tier})</span>
                    )}
                  </td>
                  <td className="num tnum">{l.qty}</td>
                  <td className="num tnum">{naira(l.unit_price)}</td>
                  <td className="num tnum">{naira(l.qty * l.unit_price)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="4" className="num font-bold">Total</td>
                <td className="num tnum font-bold">{naira(total)}</td>
              </tr>
            </tfoot>
          </table>

          <h3 className="mt-6 mb-2 font-bold">Payment</h3>
          <table className="invoice-table">
            <thead>
              <tr><th>Method</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {Object.entries(payments).map(([m, amt]) => (
                <tr key={m}>
                  <td>{methodLabel[m] || m}{m === 'credit' && <span className="text-dim"> — outstanding</span>}</td>
                  <td className="num tnum">{naira(amt)}</td>
                </tr>
              ))}
              {!Object.keys(payments).length && (
                <tr><td colSpan="2" className="text-dim">Nothing allocated.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="num font-bold">Allocated</td>
                <td className="num tnum font-bold">{naira(paid)}</td>
              </tr>
            </tfoot>
          </table>

          {Math.abs(total - paid) > 0.005 && (
            <p className="text-clay mt-3">
              {naira(total - paid)} unaccounted on this receipt.
            </p>
          )}

          {payments.credit > 0 && (
            <div className="invoice-balance mt-6">
              <span>Outstanding on this sale</span>
              <span className="tnum">{naira(payments.credit)}</span>
            </div>
          )}

          <p className="text-dim text-sm mt-6 invoice-foot">
            Thank you. Goods sold are checked at the point of sale.
          </p>
        </div>
      </div>

      <div className="p-5 border-t border-line flex gap-3 print:hidden">
        <button onClick={onClose} className="flex-1 h-14 rounded-2xl border border-line font-bold">
          Close
        </button>
        <button onClick={onPrint || (() => printOnly('receipt-area'))}
          className="flex-1 h-14 rounded-2xl bg-amber text-bg font-bold">Print / PDF</button>
      </div>
    </div>
  )
}
