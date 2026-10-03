import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira } from '../lib/format'
import { SUPERVISOR, is } from '../lib/roles'
import {
  loadPayrollEmployees, savePayrollEmployee, endPayrollEmployee,
  loadLinkableCustomers, loadStaffCreditOwing,
} from '../lib/data'
import { useToast } from '../components/Toast'

const BLANK = {
  full_name: '', sex: '', role_title: '', tier: 'junior', monthly_salary: '',
  bank_name: '', bank_account: '', customer_id: null, employee_code: '',
  started_on: '', ended_on: '', note: '',
}

// Staff setup for payroll. Salaries and bank accounts, so GM/admin only —
// the database enforces that too, independently of this gate.
//
// The LINK to a customer record is the point of this screen: staff credit
// at MainBar/OpenBar/Minimart/Restaurant is already in the app, but under
// inconsistent names ("Chioma (staff)", "Kelvin  Staff", "Chidera/staff").
// Matching on the name every month would be unreliable, so it is chosen
// once here and stored.
export default function PayrollStaff({ boot }) {
  const { staff, allLocations } = boot
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [customers, setCustomers] = useState([])
  const [owing, setOwing] = useState({})
  const [showLeavers, setShowLeavers] = useState(false)
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)

  const locName = useMemo(
    () => Object.fromEntries((allLocations || []).map(l => [l.id, l.name])), [allLocations])

  const refresh = useCallback(() => {
    loadPayrollEmployees(staff.branch_id, { includeLeavers: showLeavers })
      .then(setRows).catch(e => { setRows([]); toast(e.message, 'error') })
    loadLinkableCustomers(staff.branch_id).then(setCustomers).catch(() => setCustomers([]))
    loadStaffCreditOwing(staff.branch_id).then(setOwing).catch(() => setOwing({}))
  }, [staff.branch_id, showLeavers, toast])
  useEffect(refresh, [refresh])

  if (!is(staff.role, SUPERVISOR)) {
    return <p className="px-5 py-8 text-dim">Payroll is for the GM and admin only.</p>
  }

  async function save() {
    setBusy(true)
    try {
      await savePayrollEmployee(staff.branch_id, edit)
      toast(edit.id ? 'Saved' : 'Staff member added', 'success')
      setEdit(null); refresh()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function markLeft(r) {
    const when = window.prompt(`Last day for ${r.full_name}? (YYYY-MM-DD)`)
    if (!when) return
    try {
      await endPayrollEmployee(r.id, when)
      toast(`${r.full_name} marked as left on ${when}`, 'success'); refresh()
    } catch (e) { toast(e.message, 'error') }
  }

  const sections = ['management', 'junior']
  const totalFor = t => (rows || []).filter(r => r.tier === t && !r.ended_on)
    .reduce((s, r) => s + Number(r.monthly_salary), 0)

  return (
    <div className="px-5 pb-8">
      <div className="flex items-baseline justify-between py-2">
        <h1 className="text-xl font-bold">Payroll staff</h1>
        <button onClick={() => setEdit({ ...BLANK })}
          className="h-10 px-4 rounded-xl bg-amber text-bg font-bold text-sm">
          + Add
        </button>
      </div>
      <p className="text-dim text-sm mb-2">
        Salaries, bank details, and which customer account each person's
        department credit sits under.
      </p>

      <button onClick={() => setShowLeavers(v => !v)}
        className="h-9 px-3 rounded-lg border border-line text-dim text-sm mb-3">
        {showLeavers ? 'Hide people who have left' : 'Show people who have left'}
      </button>

      {rows === null && <p className="text-dim py-8 text-center">Loading…</p>}

      {sections.map(tier => {
        const list = (rows || []).filter(r => r.tier === tier)
        if (!list.length) return null
        return (
          <section key={tier} className="mt-4">
            <div className="flex items-baseline justify-between pb-1 border-b border-line">
              <h2 className="font-semibold capitalize">{tier} staff</h2>
              <span className="tnum text-dim text-sm">
                {naira(totalFor(tier))} / month
              </span>
            </div>
            {list.map(r => {
              const owe = owing[r.customer_id]
              return (
                <div key={r.id}
                  className={`py-3 border-b border-line/60 ${r.ended_on ? 'opacity-60' : ''}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold truncate">{r.full_name}</span>
                    <span className="tnum font-bold shrink-0">{naira(r.monthly_salary)}</span>
                  </div>
                  <div className="text-dim text-sm truncate">
                    {r.role_title}
                    {r.ended_on && ` · left ${r.ended_on}`}
                  </div>
                  <div className="text-dim text-xs truncate">
                    {r.bank_name ? `${r.bank_name} · ${r.bank_account || 'no account'}` : 'No bank details'}
                  </div>

                  {/* The credit link, and what it would pull this month. */}
                  {r.customer_id ? (
                    <div className="text-xs mt-1">
                      <span className="text-leaf">Credit: {r.customerName}</span>
                      {owe
                        ? <span className="text-clay">
                            {' '}· owes {naira(owe.total)} (
                            {Object.entries(owe.byLocation)
                              .map(([id, amt]) => `${locName[id] || '?'} ${naira(amt)}`)
                              .join(', ')})
                          </span>
                        : <span className="text-dim"> · nothing owing</span>}
                    </div>
                  ) : (
                    <div className="text-dim text-xs mt-1">
                      Not linked — department credit will not be deducted automatically.
                    </div>
                  )}

                  <div className="flex gap-2 mt-2">
                    <button onClick={() => setEdit({ ...r })}
                      className="h-9 px-3 rounded-lg border border-line text-dim text-sm">
                      Edit
                    </button>
                    {!r.ended_on && (
                      <button onClick={() => markLeft(r)}
                        className="h-9 px-3 rounded-lg border border-clay text-clay text-sm">
                        Mark as left
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}

      {edit && (
        <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
          <div className="px-5 py-6">
            <button onClick={() => setEdit(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">
              {edit.id ? edit.full_name : 'New staff member'}
            </h2>

            {[['full_name', 'Full name', 'text'],
              ['role_title', 'Role', 'text'],
              ['monthly_salary', 'Monthly salary', 'number'],
              ['bank_name', 'Bank', 'text'],
              ['bank_account', 'Account number', 'text'],
              ['employee_code', 'Staff number (optional)', 'text'],
              ['started_on', 'Started', 'date'],
              ['ended_on', 'Left (leave empty if still working)', 'date'],
            ].map(([k, label, type]) => (
              <div key={k} className="mt-4">
                <label className="block text-dim text-sm">{label}</label>
                <input type={type} value={edit[k] ?? ''}
                  inputMode={type === 'number' ? 'decimal' : undefined}
                  onChange={e => setEdit(v => ({ ...v, [k]: e.target.value }))}
                  className="mt-1 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
              </div>
            ))}

            <div className="mt-4">
              <label className="block text-dim text-sm mb-1">Tier</label>
              <div className="flex gap-2">
                {['management', 'junior'].map(t => (
                  <button key={t} onClick={() => setEdit(v => ({ ...v, tier: t }))}
                    className={`flex-1 h-11 rounded-xl border capitalize ${edit.tier === t
                      ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                    {t}
                  </button>
                ))}
              </div>
              <p className="text-dim text-xs mt-1">
                Only management take part in the contribution pot.
              </p>
            </div>

            <div className="mt-4">
              <label className="block text-dim text-sm mb-1">Sex</label>
              <div className="flex gap-2">
                {['M', 'F'].map(t => (
                  <button key={t} onClick={() => setEdit(v => ({ ...v, sex: t }))}
                    className={`flex-1 h-11 rounded-xl border ${edit.sex === t
                      ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
                    {t === 'M' ? 'Male' : 'Female'}
                  </button>
                ))}
              </div>
            </div>

            {/* Chosen once, used every month. */}
            <div className="mt-4">
              <label className="block text-dim text-sm mb-1">
                Department credit account
              </label>
              <select value={edit.customer_id || ''}
                onChange={e => setEdit(v => ({ ...v, customer_id: e.target.value || null }))}
                className="h-12 w-full px-3 rounded-xl bg-surface border border-line">
                <option value="">Not linked</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p className="text-dim text-xs mt-1">
                Links this person to the customer account their bar and minimart
                credit is recorded under, so it can be deducted automatically.
              </p>
            </div>

            <div className="mt-4">
              <label className="block text-dim text-sm">Note</label>
              <input value={edit.note ?? ''}
                onChange={e => setEdit(v => ({ ...v, note: e.target.value }))}
                className="mt-1 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
            </div>

            <button onClick={save} disabled={busy}
              className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEdit(null)}
              className="mt-2 w-full h-12 text-dim">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
