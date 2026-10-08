import { useState } from 'react'
import { methodLabel, naira } from '../lib/format'

// "Match your Total Sales" — the check a rushed person does before leaving.
//
// Total Sales is everything the department took in: POS, Cash, Credit given,
// plus any old debt recovered today. The person types what the POS slip says,
// what they counted in the drawer, and (optionally) the credit they gave. The
// app compares each with what was entered and shows the gap.
//
// Then "Find the mistake": every entry of the day, filterable by payment type,
// each with a Fix button (change quantity or Cash/POS) so the correction is
// made right here. Nothing changes by itself: it points, the person decides.
// Credit needs a customer, so credit is never created here, only kept or cleared.

const round2 = n => Math.round(n * 100) / 100
const near = (a, b) => Math.abs(a - b) < 0.51

const sumMethod = (rows, m) => rows.reduce((s, r) =>
  s + (r.sale_payments || []).filter(p => p.method === m)
      .reduce((a, p) => a + Number(p.amount), 0), 0)

export default function MatchTill({ rows = [], posTotal = null, cashTotal = null,
                                    recovered = {}, folio = {}, creditApp = null,
                                    itemName = () => '', onFix, busyId = null, onRecord = null }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState('')
  const [cash, setCash] = useState('')
  const [credit, setCredit] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState('all')
  const [fixing, setFixing] = useState(null)   // { id, qty, method }

  // Only paid sales: PR, damage and staff meals take no money.
  const sales = rows.filter(r => r.order_type !== 'pr_damage' && r.order_type !== 'staff')
  // The drawer and the terminal also hold money from OLD debts paid today.
  const appPos = posTotal ?? round2(sumMethod(sales, 'pos') + Number(recovered.pos || 0) + Number(folio.pos || 0))
  const appCash = cashTotal ?? round2(sumMethod(sales, 'cash') + Number(recovered.cash || 0) + Number(folio.cash || 0))
  const appCredit = creditApp ?? round2(sumMethod(sales, 'credit'))
  const showCredit = creditApp !== null || rows.length > 0

  const has = v => v !== '' && !Number.isNaN(Number(v))
  const hasPos = has(pos), hasCash = has(cash), hasCredit = showCredit && has(credit)
  const posGap = hasPos ? round2(appPos - Number(pos)) : null       // + : app has MORE
  const cashGap = hasCash ? round2(Number(cash) - appCash) : null   // + : drawer has MORE
  const creditGap = hasCredit ? round2(appCredit - Number(credit)) : null // + : app has MORE

  const posOk = hasPos && near(posGap, 0)
  const cashOk = hasCash && near(cashGap, 0)
  const creditOk = hasCredit && near(creditGap, 0)
  const anyGap = (hasPos && !posOk) || (hasCash && !cashOk) || (hasCredit && !creditOk)
  const allOk = posOk && cashOk && (!showCredit || !has(credit) || creditOk)

  function suspects(method, gap) {
    const out = []
    for (const r of sales) {
      const pays = r.sale_payments || []
      for (const p of pays) {
        if (p.method !== method) continue
        out.push({ row: r, pay: p, exact: near(Number(p.amount), Math.abs(gap)) })
      }
    }
    return out.sort((a, b) => Number(b.exact) - Number(a.exact)
      || (b.row.created_at || '').localeCompare(a.row.created_at || ''))
  }
  const suspectRows = []
  if (hasPos && !posOk) suspectRows.push(...suspects(posGap > 0 ? 'pos' : 'cash', posGap))
  else if (hasCash && !cashOk) suspectRows.push(...suspects(cashGap > 0 ? 'pos' : 'cash', cashGap))
  if (hasCredit && !creditOk && creditGap > 0) suspectRows.push(...suspects('credit', creditGap))
  const exactIds = new Set(suspectRows.filter(s => s.exact).map(s => s.row.id))

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-3 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
        Match your Total Sales for the day
      </button>
    )
  }

  const timeOf = t => t ? new Date(t).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : ''
  const methodOf = r => {
    const p = r.sale_payments || []
    return p.length === 1 ? p[0].method : p.length ? 'split' : 'none'
  }

  // Entries to look through. Anything matching a gap floats to the top.
  const list = sales
    .filter(r => filter === 'all' || (r.sale_payments || []).some(p => p.method === filter))
    .sort((a, b) => Number(exactIds.has(b.id)) - Number(exactIds.has(a.id))
      || (b.created_at || '').localeCompare(a.created_at || ''))
  const visible = showAll || anyGap ? list : []

  const Row = ({ label, hint, app, value, set, gap, ok, higher, lower }) => (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <label className="font-semibold">{label}</label>
        <span className="text-dim text-sm shrink-0">App has <span className="tnum">{naira(app)}</span></span>
      </div>
      {hint && <p className="text-dim text-xs">{hint}</p>}
      <input type="number" inputMode="decimal" value={value}
        onChange={e => { set(e.target.value); setSaved(false) }} placeholder="0"
        className="mt-1 w-full h-12 px-3 rounded-xl bg-raise border border-line tnum text-lg" />
      {value !== '' && (
        <p className={`mt-1 text-sm font-semibold ${ok ? 'text-leaf' : 'text-clay'}`}>
          {ok ? 'Matches ✓' : `${naira(Math.abs(gap))} ${gap > 0 ? higher : lower}`}
        </p>
      )}
    </div>
  )

  const fixer = (r) => {
    const pays = r.sale_payments || []
    const cur = methodOf(r)
    if (cur === 'split' || cur === 'none') {
      return <p className="text-dim text-xs mt-2">Split payment. Ask your manager to correct this one.</p>
    }
    const f = fixing && fixing.id === r.id ? fixing : { id: r.id, qty: r.qty, method: cur }
    const methods = ['cash', 'pos', ...(cur === 'credit' ? ['credit'] : [])]
    const changed = Number(f.qty) !== Number(r.qty) || f.method !== cur
    return (
      <div className="mt-2 rounded-xl bg-raise border border-line p-3">
        <div className="flex items-center gap-2">
          <span className="text-dim text-sm w-16">Quantity</span>
          <button onClick={() => setFixing({ ...f, qty: Math.max(1, Number(f.qty) - 1) })}
            className="h-10 w-10 rounded-lg bg-surface border border-line text-xl">−</button>
          <span className="tnum w-8 text-center font-bold">{f.qty}</span>
          <button onClick={() => setFixing({ ...f, qty: Number(f.qty) + 1 })}
            className="h-10 w-10 rounded-lg bg-surface border border-line text-xl">+</button>
          <span className="tnum ml-auto font-semibold">{naira(Number(f.qty) * Number(r.unit_price))}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-dim text-sm w-16">Paid by</span>
          {methods.map(m => (
            <button key={m} onClick={() => setFixing({ ...f, method: m })}
              className={`h-10 px-3 rounded-lg border text-sm font-semibold ${
                f.method === m ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
              {methodLabel[m] || m}
            </button>
          ))}
        </div>
        {cur !== 'credit' && (
          <p className="text-dim text-xs mt-2">A sale on credit needs a customer, so it must be recorded as a new sale.</p>
        )}
        <div className="mt-2 flex gap-2">
          <button disabled={!changed || busyId === r.id}
            onClick={async () => { const ok = await onFix(r, { qty: Number(f.qty), method: f.method }); if (ok !== false) setFixing(null) }}
            className="flex-1 h-10 rounded-lg bg-amber text-bg font-bold disabled:opacity-40">
            {busyId === r.id ? 'Saving…' : 'Save correction'}
          </button>
          <button onClick={() => setFixing(null)} className="h-10 px-3 rounded-lg border border-line text-dim text-sm">Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-2xl border border-amber bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="font-semibold">Match your Total Sales</p>
        <button onClick={() => setOpen(false)} className="text-dim text-sm">Close</button>
      </div>
      <p className="text-dim text-sm mt-1">
        Total Sales is your POS, Cash and Credit (plus any old debt paid today).
        Type what you have in hand and the app shows where it does not agree.
      </p>

      <Row label="POS slip total" app={appPos} value={pos} set={setPos} gap={posGap} ok={posOk}
        hint={[Number(recovered.pos) > 0 && `Includes ${naira(recovered.pos)} of old debt paid by POS`, Number(folio.pos) > 0 && `Includes ${naira(folio.pos)} paid on room folios through your POS`].filter(Boolean).join('. ') || null}
        higher="more on the app than on the POS slip" lower="less on the app than on the POS slip" />
      <Row label="Cash in your drawer" app={appCash} value={cash} set={setCash} gap={cashGap} ok={cashOk}
        hint={[Number(recovered.cash) > 0 && `Includes ${naira(recovered.cash)} of old debt paid in cash`, Number(folio.cash) > 0 && `Includes ${naira(folio.cash)} paid on room folios in cash`].filter(Boolean).join('. ') || null}
        higher="more cash than the app expects" lower="less cash than the app expects" />
      {showCredit && (
        <Row label="Credit you gave today" app={appCredit} value={credit} set={setCredit} gap={creditGap} ok={creditOk}
          hint="From your own record of who took on credit (leave empty if you keep none)"
          higher="more credit on the app than you recorded" lower="less credit on the app than you recorded" />
      )}

      {allOk && (
        <p className="mt-4 rounded-xl bg-leaf/15 text-leaf font-bold p-3 text-center">
          Total Sales matched. You can close ✓
        </p>
      )}

      {anyGap && (
        <div className="mt-4 rounded-xl border border-clay/60 p-3">
          <p className="font-semibold text-clay">Something does not agree. Find it below.</p>
          <ul className="text-dim text-sm mt-1 list-disc pl-5 space-y-1">
            {hasPos && !posOk && <li>{posGap > 0
              ? 'POS: an entry marked POS may really be Cash or Credit, or a POS sale is missing from the app.'
              : 'POS: the terminal has more than the app. A POS sale may have been entered as Cash.'}</li>}
            {hasCash && !cashOk && <li>{cashGap > 0
              ? 'Cash: you have more than the app. A cash sale may have been entered as POS or Credit.'
              : 'Cash: you have less than the app. A cash sale may have been entered as POS, or cash was paid out.'}</li>}
            {hasCredit && !creditOk && <li>{creditGap > 0
              ? 'Credit: the app shows more credit than you recorded. A credit entry may really have been paid.'
              : 'Credit: you recorded more credit than the app has. A credit sale may be missing or entered as Cash/POS.'}</li>}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowAll(s => !s)}
            className="w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
            {showAll || anyGap ? 'Your entries today' : 'Find a mistake: see your entries'} ({sales.length})
          </button>

          {(showAll || anyGap) && (
            <>
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {['all', 'pos', 'cash', 'credit'].map(k => (
                  <button key={k} onClick={() => setFilter(k)}
                    className={`h-9 px-3 rounded-full border text-sm font-semibold shrink-0 ${
                      filter === k ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                    {k === 'all' ? 'All' : methodLabel[k]}
                  </button>
                ))}
              </div>
              {anyGap && exactIds.size > 0 && (
                <p className="text-dim text-xs mt-2">Entries marked <span className="text-amber font-bold">likely</span> are the same amount as the gap.</p>
              )}
              <ul className="mt-2 divide-y divide-line/60 max-h-[28rem] overflow-y-auto">
                {visible.map(r => (
                  <li key={r.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-semibold">
                          {itemName(r)} <span className="text-dim font-normal">× {r.qty}</span>
                          {exactIds.has(r.id) && <span className="ml-2 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">likely</span>}
                        </div>
                        <div className="text-dim text-sm tnum">
                          {naira(r.amount)} · {methodOf(r) === 'split' ? 'Split' : methodLabel[methodOf(r)] || ''} · {timeOf(r.created_at)}
                        </div>
                      </div>
                      {onFix && (
                        <button onClick={() => setFixing(fixing?.id === r.id ? null
                            : { id: r.id, qty: r.qty, method: methodOf(r) })}
                          className="h-10 px-3 rounded-lg border border-amber text-amber text-sm font-semibold shrink-0">
                          Fix
                        </button>
                      )}
                    </div>
                    {onFix && fixing?.id === r.id && fixer(r)}
                  </li>
                ))}
                {!visible.length && <li className="py-3 text-dim text-sm">No entries under this type.</li>}
              </ul>
            </>
          )}
        </div>
      )}

      {onRecord && hasPos && hasCash && (
        saved ? (
          <p className="mt-4 text-center text-leaf font-semibold">Result saved for your manager ✓</p>
        ) : (
          <button disabled={saving}
            onClick={async () => {
              setSaving(true)
              try { await onRecord({ appPos, appCash, pos: Number(pos), cash: Number(cash) }); setSaved(true) }
              catch { /* never block closing */ }
              setSaving(false)
            }}
            className="mt-4 w-full h-12 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
            {saving ? 'Saving…' : 'Save my result'}
          </button>
        )
      )}
    </div>
  )
}
