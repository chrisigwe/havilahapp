import { useState } from 'react'
import { naira } from '../lib/format'

// "Match your till" — the check a rushed person does before leaving.
//
// They type what the POS terminal slip says and what they counted in the
// drawer. The app compares both with what was entered and shows the gap.
// Most mistakes are ONE entry, so when a single payment equals the gap it
// is named, with a one-tap switch between Cash and POS.
//
// It never changes anything by itself: it points, the person decides.
// Credit mistakes cannot be switched here (a credit needs a customer), so
// those are named and sent to the manager.

const round2 = n => Math.round(n * 100) / 100
const near = (a, b) => Math.abs(a - b) < 0.51

function sumMethod(rows, m) {
  return rows.reduce((s, r) =>
    s + (r.sale_payments || []).filter(p => p.method === m)
        .reduce((a, p) => a + Number(p.amount), 0), 0)
}

export default function MatchTill({ rows = [], posTotal = null, cashTotal = null,
                                    itemName = () => '', onSwitch, busyId = null }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState('')
  const [cash, setCash] = useState('')

  // Only paid sales: PR, damage and staff meals take no money.
  const sales = rows.filter(r => r.order_type !== 'pr_damage' && r.order_type !== 'staff')
  const appPos = posTotal ?? sumMethod(sales, 'pos')
  const appCash = cashTotal ?? sumMethod(sales, 'cash')

  const hasPos = pos !== '' && !Number.isNaN(Number(pos))
  const hasCash = cash !== '' && !Number.isNaN(Number(cash))
  // + means the app holds MORE POS than the terminal does
  const posGap = hasPos ? round2(appPos - Number(pos)) : null
  // + means MORE cash in the drawer than the app says
  const cashGap = hasCash ? round2(Number(cash) - appCash) : null

  const posOk = hasPos && near(posGap, 0)
  const cashOk = hasCash && near(cashGap, 0)
  const allOk = posOk && cashOk

  // Entries that could be the mistake. A payment of exactly the gap is the
  // strong suspect. Only whole single-method sales can be switched in one
  // tap; a split sale has to be corrected from the entry itself.
  function suspects(method, gap) {
    const out = []
    for (const r of sales) {
      const pays = r.sale_payments || []
      for (const p of pays) {
        if (p.method !== method) continue
        out.push({ row: r, pay: p, exact: near(Number(p.amount), Math.abs(gap)),
                   switchable: pays.length === 1 })
      }
    }
    return out.sort((a, b) => Number(b.exact) - Number(a.exact)
      || (b.row.created_at || '').localeCompare(a.row.created_at || ''))
  }

  const wrongPos = hasPos && !posOk && posGap > 0 ? suspects('pos', posGap) : []
  const wrongCash = hasPos && !posOk && posGap < 0 ? suspects('cash', posGap) : []
  const list = (wrongPos.length ? wrongPos : wrongCash).slice(0, 6)
  const switchTo = wrongPos.length ? 'cash' : 'pos'
  const exactCount = list.filter(s => s.exact).length

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-3 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
        Match your till before you leave
      </button>
    )
  }

  const Row = ({ label, app, value, set, gap, ok }) => (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <label className="font-semibold">{label}</label>
        <span className="text-dim text-sm">App has <span className="tnum">{naira(app)}</span></span>
      </div>
      <input type="number" inputMode="decimal" value={value}
        onChange={e => set(e.target.value)} placeholder="0"
        className="mt-1 w-full h-12 px-3 rounded-xl bg-raise border border-line tnum text-lg" />
      {value !== '' && (
        <p className={`mt-1 text-sm font-semibold ${ok ? 'text-leaf' : 'text-clay'}`}>
          {ok ? 'Matches ✓'
            : label.startsWith('POS')
              ? `App is ${naira(Math.abs(gap))} ${gap > 0 ? 'MORE' : 'LESS'} than the terminal`
              : `Drawer has ${naira(Math.abs(gap))} ${gap > 0 ? 'MORE' : 'LESS'} than the app says`}
        </p>
      )}
    </div>
  )

  return (
    <div className="mt-3 rounded-2xl border border-amber bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="font-semibold">Match your till</p>
        <button onClick={() => setOpen(false)} className="text-dim text-sm">Close</button>
      </div>
      <p className="text-dim text-sm mt-1">
        Type what the POS slip says and the cash you counted. Takes ten seconds
        and finds the usual mistakes before you leave.
      </p>

      <Row label="POS terminal total" app={appPos} value={pos} set={setPos}
           gap={posGap} ok={posOk} />
      <Row label="Cash counted (today's sales)" app={appCash} value={cash} set={setCash}
           gap={cashGap} ok={cashOk} />

      {allOk && (
        <p className="mt-4 rounded-xl bg-leaf/15 text-leaf font-bold p-3 text-center">
          All matched. You can close ✓
        </p>
      )}

      {hasPos && !posOk && (
        <div className="mt-4 rounded-xl border border-clay/60 p-3">
          <p className="font-semibold text-clay">
            {posGap > 0
              ? `${naira(posGap)} was entered as POS but did not go through the terminal`
              : `${naira(-posGap)} went through the terminal but was not entered as POS`}
          </p>
          <p className="text-dim text-sm mt-1">
            {posGap > 0
              ? (hasCash && cashGap > 0 && near(cashGap, posGap)
                  ? 'Your drawer has the same extra amount — a cash sale was probably entered as POS.'
                  : 'If it was cash, switch it below. If it was credit, ask your manager to correct it.')
              : 'A card sale was probably entered as cash.'}
          </p>
          {list.length > 0 && (
            <ul className="mt-2 divide-y divide-line/60">
              {list.map(({ row, pay, exact, switchable }) => (
                <li key={`${row.id}:${pay.id || pay.amount}`} className="py-2 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-semibold">
                      {itemName(row)} <span className="text-dim font-normal">× {row.qty}</span>
                      {exact && <span className="ml-2 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">matches</span>}
                    </div>
                    <div className="text-dim text-sm tnum">
                      {naira(pay.amount)} · {new Date(row.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  {switchable && onSwitch ? (
                    <button disabled={busyId === row.id}
                      onClick={() => onSwitch(row, switchTo)}
                      className="h-10 px-3 rounded-lg border border-amber text-amber text-sm font-semibold shrink-0 disabled:opacity-40">
                      Mark as {switchTo === 'cash' ? 'Cash' : 'POS'}
                    </button>
                  ) : (
                    <span className="text-dim text-xs shrink-0">split sale — edit it</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {exactCount === 0 && list.length > 0 && (
            <p className="text-dim text-xs mt-2">
              No single entry matches the gap exactly, so it may be several entries or one with the wrong amount.
            </p>
          )}
        </div>
      )}

      {hasCash && !cashOk && (!hasPos || posOk) && (
        <div className="mt-4 rounded-xl border border-clay/60 p-3">
          <p className="font-semibold text-clay">
            {cashGap > 0
              ? `${naira(cashGap)} more cash than the app expects`
              : `${naira(-cashGap)} less cash than the app expects`}
          </p>
          <p className="text-dim text-sm mt-1">
            {cashGap > 0
              ? 'A cash sale may have been entered as credit, or a payment was left out.'
              : 'A cash sale may have been entered as POS or credit, or cash was handed out. Check today’s entries below before you leave.'}
          </p>
        </div>
      )}
    </div>
  )
}
