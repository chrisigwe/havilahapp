import { useCallback, useEffect, useState } from 'react'
import { naira, lagosToday } from '../lib/format'
import { useToast } from '../components/Toast'
import {
  addDeduction, endEmployment, finalisePeriod, lineTotals, loadCustomersForLinking, loadEmployees, loadLines, loadPayouts, loadPeriod, loadPotNext, openPeriod, proposeCreditDeductions, removeDeduction, reopenPeriod, saveEmployee, savePayout, savingsBalances, setEmployeeCreditAccount, updateLine,
} from '../lib/payroll'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

// Payroll — GM/admin only. Every table's RLS enforces that too, so this
// screen is the convenience, not the lock.
//
// Mirrors the two workbooks without copying their faults: Awka's
// "Amount Receivable" column reads 0 for everyone (a broken formula) and
// is not reproduced. Net follows Nnewi's consistent arithmetic, which
// lives in lineTotals() so the screen and the print view can never
// disagree.
export default function Payroll({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const today = new Date(lagosToday())
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [period, setPeriod] = useState(null)
  const [lines, setLines] = useState(null)
  const [payouts, setPayouts] = useState([])
  const [potNext, setPotNext] = useState(null)
  const [savings, setSavings] = useState({})
  const [employees, setEmployees] = useState([])
  const [busy, setBusy] = useState(false)
  const [editEmp, setEditEmp] = useState(null)
  const [recordingPayout, setRecordingPayout] = useState(null)
  const [view, setView] = useState('month')   // 'month' | 'people'

  const final = period?.status === 'final'

  const refresh = useCallback(async () => {
    try {
      const p = await loadPeriod(staff.branch_id, year, month)
      setPeriod(p)
      setLines(p ? await loadLines(p.id) : null)
      setPayouts(p ? await loadPayouts(p.id) : [])
      setEmployees(await loadEmployees(staff.branch_id, { includeLeavers: true }))
      setPotNext(await loadPotNext(staff.branch_id))
      setSavings(await savingsBalances(staff.branch_id))
    } catch (e) { toast(e.message, 'error') }
  }, [staff.branch_id, year, month, toast])

  useEffect(() => { refresh() }, [refresh])

  async function doOpen() {
    setBusy(true)
    try { await openPeriod(staff.branch_id, year, month); await refresh()
      toast(`${MONTHS[month - 1]} ${year} opened`, 'success')
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  // Proposes each person's current department credit as deductions. The
  // GM reviews and edits before finalising — nothing is applied blind.
  async function doPullCredit() {
    setBusy(true)
    try {
      const withCustomer = lines.map(l => ({
        ...l, customer_id: employees.find(e => e.id === l.employee_id)?.customer_id }))
      const proposed = await proposeCreditDeductions(staff.branch_id, withCustomer, year, month)
      let added = 0
      for (const l of withCustomer) {
        const items = proposed[l.customer_id] || []
        for (const it of items) {
          // Never add the same automatic pull twice for this month —
          // location_id is null now (one figure per month, not per
          // department), so this checks the auto flag and source alone.
          const already = (l.payroll_deduction || []).some(d => d.auto && d.source === 'credit')
          if (already) continue
          await addDeduction(l.id, { source: 'credit', location_id: it.location_id,
                                     customer_id: l.customer_id, amount: it.amount,
                                     note: it.note, auto: true })
          added++
        }
      }
      await refresh()
      toast(added ? `${added} credit deduction(s) added — check them before finalising`
                  : 'No outstanding department credit to deduct', added ? 'success' : 'info')
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  const payoutFor = (employeeId) =>
    Number(payouts.find(p => p.employee_id === employeeId)?.amount || 0)

  const totals = (lines || []).reduce((t, l) => {
    const x = lineTotals(l, payoutFor(l.employee_id), period?.working_days)
    t.salary += Number(l.monthly_salary || 0); t.deductions += x.deductions
    t.contribution += x.contribution; t.savings += x.savings
    t.net += x.net; t.documented += x.documented; t.gift += x.gift
    return t
  }, { salary: 0, deductions: 0, contribution: 0, savings: 0, net: 0, documented: 0, gift: 0 })

  const groups = ['management', 'junior']

  return (
    <div className="px-5 pb-28">
      <div className="print:hidden">
        <div className="flex gap-2 py-2">
          {['month', 'people'].map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`h-10 px-4 rounded-full border text-sm font-semibold ${view === v
                ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
              {v === 'month' ? 'Monthly payroll' : 'Employees'}
            </button>
          ))}
        </div>
      </div>

      {view === 'people' ? (
        <People employees={employees} savings={savings} onEdit={setEditEmp}
          onAdd={() => setEditEmp({ branch_id: staff.branch_id, tier: 'junior', monthly_salary: 0 })} />
      ) : (
        <>
          <div className="print:hidden flex flex-wrap items-center gap-2 py-2">
            <select value={month} onChange={e => setMonth(Number(e.target.value))}
              className="h-11 px-3 rounded-xl bg-raise border border-line">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              className="h-11 px-3 rounded-xl bg-raise border border-line tnum">
              {[year - 2, year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            {!period && (
              <button onClick={doOpen} disabled={busy}
                className="h-11 px-4 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
                Open this month
              </button>
            )}
            {period && !final && (
              <>
                <button onClick={doPullCredit} disabled={busy}
                  className="h-11 px-4 rounded-xl border border-amber text-amber font-semibold">
                  Pull credit deductions
                </button>
                <button onClick={() => window.print()}
                  className="h-11 px-4 rounded-xl border border-line text-dim font-semibold">
                  Print
                </button>
              </>
            )}
            {final && (
              <button onClick={() => window.print()}
                className="h-11 px-4 rounded-xl bg-amber text-bg font-bold">Print</button>
            )}
          </div>

          {period && (
            <div className="invoice-print">
              <div className="invoice-head">
                <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
                <div className="flex items-baseline justify-between">
                  <p className="text-dim">{boot.branchName} · Payroll · {MONTHS[month - 1]} {year}</p>
                  <p className="text-dim text-sm">
                    {final ? 'Final' : 'Draft'} · {period.working_days} working days
                  </p>
                </div>
              </div>

              {potNext && !final && (
                <div className="print:hidden mt-2 rounded-xl border border-line p-3">
                  <p className="text-dim text-sm">
                    Pot: next turn is {potNext.full_name} (#{potNext.turn_no} of {potNext.members},
                    {' '}{potNext.taken} taken so far).
                  </p>
                  {/* Nothing on this page could previously RECORD a
                      payout — savePayout existed but nothing called it,
                      and the rotation could never advance. This is the
                      missing control. Who actually took it can differ
                      from "next in line" (the GM covering a departed
                      manager's share, say), so the name is editable. */}
                  {!payouts.length ? (
                    <button onClick={() => setRecordingPayout({
                        employee_id: potNext.employee_id, amount: '', note: '' })}
                      className="mt-2 h-10 px-3 rounded-lg border border-amber text-amber text-sm font-semibold">
                      Record this month's payout
                    </button>
                  ) : (
                    <p className="text-leaf text-sm mt-1">
                      {payouts.map(p =>
                        `${employees.find(e => e.id === p.employee_id)?.full_name || '?'}: ${naira(p.amount)}`
                      ).join(', ')}
                      {' '}— marked taken when this month is finalised.
                    </p>
                  )}
                </div>
              )}

              {groups.map(g => {
                const rows = (lines || []).filter(l => l.tier === g)
                if (!rows.length) return null
                return (
                  <section key={g} className="mt-4">
                    <h2 className="font-bold uppercase text-sm tracking-wide">
                      {g === 'management' ? 'Management staff' : 'Junior staff'}
                    </h2>
                    <table className="invoice-table w-full mt-1">
                      <thead>
                        <tr>
                          <th>Name</th><th>Role</th>
                          <th className="num">Salary</th><th className="num">Days</th>
                          <th className="num">Deductions</th><th className="num">Add</th>
                          <th className="num">Contrib</th><th className="num">Savings</th>
                          <th className="num">Net pay</th>
                          <th className="num">Documented</th><th className="num">Gift</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(l => {
                          const x = lineTotals(l, payoutFor(l.employee_id), period?.working_days)
                          return (
                            <tr key={l.id} onClick={() => !final && setEditEmp({ line: l })}
                              className={final ? '' : 'cursor-pointer'}>
                              <td>{l.full_name}</td>
                              <td className="text-dim">{l.role_title}</td>
                              <td className="num tnum">{naira(l.monthly_salary)}</td>
                              <td className="num tnum">{l.days_worked}</td>
                              <td className="num tnum">{x.deductions ? naira(x.deductions) : '—'}</td>
                              <td className="num tnum">{x.additions ? naira(x.additions) : '—'}</td>
                              <td className="num tnum">{x.contribution ? naira(x.contribution) : '—'}</td>
                              <td className="num tnum">{x.savings ? naira(x.savings) : '—'}</td>
                              <td className={`num tnum font-bold ${x.net < 0 ? 'text-clay' : ''}`}>
                                {naira(x.net)}
                              </td>
                              <td className="num tnum">{naira(x.documented)}</td>
                              <td className="num tnum">{x.gift ? naira(x.gift) : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </section>
                )
              })}

              <div className="invoice-balance mt-4 pt-2">
                <table className="invoice-table w-full">
                  <tbody>
                    <tr><td>Total salary</td><td className="num tnum">{naira(totals.salary)}</td></tr>
                    <tr><td>Total deductions</td><td className="num tnum">{naira(totals.deductions)}</td></tr>
                    <tr><td>Paid into the pot</td><td className="num tnum">{naira(totals.contribution)}</td></tr>
                    <tr><td>Held as savings</td><td className="num tnum">{naira(totals.savings)}</td></tr>
                    <tr><td className="font-bold">Total net pay</td>
                        <td className="num tnum font-bold">{naira(totals.net)}</td></tr>
                    <tr><td>Documented</td><td className="num tnum">{naira(totals.documented)}</td></tr>
                    <tr><td>Recorded as gift</td><td className="num tnum">{naira(totals.gift)}</td></tr>
                  </tbody>
                </table>
              </div>

              <div className="invoice-foot mt-6 text-dim text-sm">
                {final
                  ? `Finalised${period.finalised_at ? ' ' + period.finalised_at.slice(0, 10) : ''}.`
                  : 'Draft — figures may still change.'}
              </div>
            </div>
          )}

          {period && (
            <div className="print:hidden mt-6">
              {final
                ? <button onClick={async () => { await reopenPeriod(period.id); refresh() }}
                    className="h-12 w-full rounded-xl border border-clay text-clay font-semibold">
                    Reopen this month to change it
                  </button>
                : <button onClick={async () => {
                      if (!window.confirm('Finalise this month? It will be frozen until reopened.')) return
                      const r = await finalisePeriod(period.id, staff.id); refresh()
                      // Says what actually moved, since finalising now
                      // commits three separate things silently otherwise —
                      // easy to assume it "just works" and not notice one
                      // part was skipped (e.g. no pot payout recorded).
                      const parts = []
                      if (r.repayments) parts.push(`${r.repayments} credit repayment(s)`)
                      if (r.deposits) parts.push(`${r.deposits} savings deposit(s)`)
                      if (r.payouts) parts.push(`${r.payouts} pot payout(s) marked taken`)
                      toast(parts.length ? `Month finalised — ${parts.join(', ')}` : 'Month finalised', 'success')
                    }}
                    className="h-12 w-full rounded-xl bg-amber text-bg font-bold">
                    Finalise {MONTHS[month - 1]} {year}
                  </button>}
            </div>
          )}

          {!period && lines === null && (
            <p className="text-dim py-8 text-center">
              {MONTHS[month - 1]} {year} has not been opened yet.
            </p>
          )}
        </>
      )}

      {recordingPayout && (
        <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
          <div className="px-5 py-6">
            <button onClick={() => setRecordingPayout(null)} className="text-dim">Back</button>
            <h3 className="mt-3 text-2xl font-bold">
              Pot payout — {employees.find(e => e.id === recordingPayout.employee_id)?.full_name}
            </h3>
            <p className="text-dim text-sm mt-1">
              Who actually took the pot this month, and how much. Does not have to
              match "next in line" — change the name below if someone else took it.
            </p>

            <label className="block text-dim text-sm mt-4">Who took it</label>
            <select value={recordingPayout.employee_id}
              onChange={e => setRecordingPayout(r => ({ ...r, employee_id: e.target.value }))}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line">
              {employees.filter(e => e.tier === 'management').map(e => (
                <option key={e.id} value={e.id}>{e.full_name}</option>
              ))}
            </select>

            <label className="block text-dim text-sm mt-4">Amount</label>
            <input type="number" inputMode="decimal" value={recordingPayout.amount}
              onChange={e => setRecordingPayout(r => ({ ...r, amount: e.target.value }))}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line tnum" />

            <label className="block text-dim text-sm mt-4">Note</label>
            <input value={recordingPayout.note}
              onChange={e => setRecordingPayout(r => ({ ...r, note: e.target.value }))}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line" />

            <button disabled={busy || !recordingPayout.amount}
              onClick={async () => {
                setBusy(true)
                try {
                  await savePayout(period.id, recordingPayout.employee_id,
                    Number(recordingPayout.amount), recordingPayout.note || null)
                  toast('Payout recorded — marked taken when this month is finalised', 'success')
                  setRecordingPayout(null); await refresh()
                } catch (e) { toast(e.message, 'error') }
                setBusy(false)
              }}
              className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
              {busy ? 'Saving…' : 'Save payout'}
            </button>
            <button onClick={() => setRecordingPayout(null)}
              className="mt-2 w-full h-12 text-dim">Cancel</button>
          </div>
        </div>
      )}

      {editEmp && (
        <EmployeeSheet value={editEmp} employees={employees} final={final}
          branchId={staff.branch_id}
          onClose={() => setEditEmp(null)}
          onSaved={async () => { setEditEmp(null); await refresh() }}
          toast={toast} />
      )}
    </div>
  )
}

function People({ employees, savings, onEdit, onAdd }) {
  const live = employees.filter(e => !e.ended_on)
  const gone = employees.filter(e => e.ended_on)
  const row = (e) => (
    <button key={e.id} onClick={() => onEdit(e)}
      className="w-full text-left py-3 border-t border-line/60 first:border-0 flex gap-3">
      <div className="flex-1 min-w-0">
        <div className="truncate">{e.full_name}</div>
        <div className="text-dim text-sm truncate">
          {e.role_title}
          {e.ended_on ? ` · left ${e.ended_on}` : ''}
          {!e.customer_id ? ' · no credit account linked' : ''}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="tnum">{naira(e.monthly_salary)}</div>
        {savings[e.id] > 0.009 && (
          <div className="text-dim text-xs tnum">saved {naira(savings[e.id])}</div>
        )}
      </div>
    </button>
  )
  return (
    <div>
      <button onClick={onAdd}
        className="my-2 h-11 px-4 rounded-xl bg-amber text-bg font-bold">+ Add employee</button>
      <div className="rounded-2xl border border-line bg-surface px-4">{live.map(row)}</div>
      {!!gone.length && (
        <>
          <p className="text-dim text-sm mt-5 mb-1">Left the company</p>
          <div className="rounded-2xl border border-line bg-surface px-4 opacity-70">{gone.map(row)}</div>
        </>
      )}
      <p className="text-dim text-xs mt-3">
        Linking someone to their credit account lets the month's deductions be pulled
        automatically from what they owe at the bars, minimart and restaurant.
      </p>
    </div>
  )
}

function EmployeeSheet({ value, employees, final, onClose, onSaved, toast, branchId }) {
  // The form saved customer_id but never offered a way to CHOOSE one, so
  // no employee could ever be linked and the credit pull had nothing to
  // work with. This is that missing picker.
  const [customers, setCustomers] = useState([])
  useEffect(() => {
    if (!branchId) return
    loadCustomersForLinking(branchId).then(setCustomers).catch(() => setCustomers([]))
  }, [branchId])

  const isLine = !!value.line
  const [f, setF] = useState(isLine ? { ...value.line } : { ...value })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))

  async function save() {
    setBusy(true)
    try {
      if (isLine) {
        await updateLine(f.id, {
          days_worked: Number(f.days_worked) || 0,
          additions: Number(f.additions) || 0,
          contribution: Number(f.contribution) || 0,
          savings: Number(f.savings) || 0,
          remark: f.remark || null,
        })
      } else {
        // Everything except the credit link, which is saved separately
        // because linking also RENAMES the credit account to the AKA.
        const saved = await saveEmployee({
          ...f, monthly_salary: Number(f.monthly_salary) || 0,
          customer_id: undefined, staff_id: f.staff_id || null,
        })
        // Use the id from the SAVE, not f.id: a new employee has no id
        // yet when this runs, so linking them would silently do nothing.
        await setEmployeeCreditAccount(saved?.id || f.id, f.customer_id || null, f.aka || null)
      }
      onSaved()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  const num = (k, label) => (
    <>
      <label className="block mt-3 text-dim text-sm">{label}</label>
      <input type="number" inputMode="decimal" value={f[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        className="mt-1 h-12 w-full px-3 rounded-xl bg-raise border border-line tnum" />
    </>
  )
  const txt = (k, label) => (
    <>
      <label className="block mt-3 text-dim text-sm">{label}</label>
      <input value={f[k] ?? ''} onChange={e => set(k, e.target.value)}
        className="mt-1 h-12 w-full px-3 rounded-xl bg-raise border border-line" />
    </>
  )

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="p-5">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">
          {isLine ? f.full_name : (f.id ? 'Edit employee' : 'Add employee')}
        </h2>

        {isLine ? (
          <>
            <p className="text-dim text-sm mt-1">
              This month only. Salary and bank details are fixed as at the month's start —
              change them under Employees.
            </p>
            {num('days_worked', 'Days worked')}
            {num('additions', 'Addition')}
            {num('contribution', 'Paid into the pot')}
            {num('savings', 'Held as savings')}
            {txt('remark', 'Remark')}
            <Deductions line={f} onChanged={onSaved} toast={toast} />
          </>
        ) : (
          <>
            {txt('full_name', 'Full name')}
            {txt('aka', 'Known as (for their credit account)')}
            <label className="block mt-3 text-dim text-sm">
              Credit account (bar, minimart, restaurant)
            </label>
            <select value={f.customer_id || ''}
              onChange={e => set('customer_id', e.target.value || null)}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line">
              <option value="">Not linked</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <p className="text-dim text-xs mt-1">
              Links this person to the account their department credit is recorded
              under, so it can be deducted from their pay. Most staff have none.
            </p>

            {f.aka && f.customer_id && (
              <p className="text-amber text-sm -mt-2 mb-2">
                Saving will rename their credit account to "{f.aka}".
              </p>
            )}
            {!f.aka && (
              <p className="text-dim text-xs -mt-2 mb-2">
                e.g. "Mercy (staff)" — the name their bar and minimart credit is
                recorded under. Keeps the naming consistent.
              </p>
            )}
            {/* Employee ID removed from the form at the user's request —
                it is not used for anything. The column stays in the
                database, so the codes already loaded from the Awka sheet
                are kept for cross-referencing the old workbooks. */}
            {txt('role_title', 'Role')}
            <label className="block mt-3 text-dim text-sm">Tier</label>
            <select value={f.tier} onChange={e => set('tier', e.target.value)}
              className="mt-1 h-12 w-full px-3 rounded-xl bg-raise border border-line">
              <option value="management">Management staff</option>
              <option value="junior">Junior staff</option>
            </select>
            {num('monthly_salary', 'Monthly salary')}
            {txt('bank_name', 'Bank')}
            {txt('bank_account', 'Account number')}
            {txt('started_on', 'Started (YYYY-MM-DD)')}
            <p className="text-dim text-xs mt-4">
              Leaving is recorded as a date, never a deletion — past months must stay intact.
            </p>
            {f.id && !f.ended_on && (
              <button onClick={async () => {
                  const d = window.prompt('Last working date (YYYY-MM-DD)', lagosToday())
                  if (!d) return
                  await endEmployment(f.id, d); onSaved()
                }}
                className="mt-2 h-11 w-full rounded-xl border border-clay text-clay font-semibold">
                Record that they have left
              </button>
            )}
          </>
        )}

        <button onClick={save} disabled={busy || final}
          className="mt-6 h-14 w-full rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
          {final ? 'Month is finalised' : busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Deductions({ line, onChanged, toast }) {
  const ded = line.payroll_deduction || []
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  return (
    <div className="mt-5 rounded-2xl border border-line bg-surface p-4">
      <p className="font-semibold">Deductions</p>
      <p className="text-dim text-xs mt-1 mb-2">
        Credit pulled from the departments appears here and can be changed or removed.
      </p>
      {ded.map(d => (
        <div key={d.id} className="flex items-center gap-2 py-1.5 border-t border-line/60 first:border-0">
          <span className="flex-1 min-w-0 truncate text-sm">
            {d.source}{d.auto ? ' · pulled' : ''}{d.note ? ` — ${d.note}` : ''}
          </span>
          <span className="tnum text-sm">{naira(d.amount)}</span>
          <button onClick={async () => { await removeDeduction(d.id); onChanged() }}
            className="text-clay text-sm">Remove</button>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <input type="number" inputMode="decimal" placeholder="Amount" value={amount}
          onChange={e => setAmount(e.target.value)}
          className="h-11 w-28 px-3 rounded-xl bg-raise border border-line tnum" />
        <input placeholder="What for" value={note} onChange={e => setNote(e.target.value)}
          className="h-11 flex-1 px-3 rounded-xl bg-raise border border-line" />
        <button onClick={async () => {
            if (!(Number(amount) > 0)) { toast('Enter an amount', 'error'); return }
            await addDeduction(line.id, { source: 'other', amount: Number(amount), note: note || null })
            setAmount(''); setNote(''); onChanged()
          }}
          className="h-11 px-4 rounded-xl border border-amber text-amber font-semibold">Add</button>
      </div>
    </div>
  )
}
