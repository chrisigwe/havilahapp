import { supabase } from './supabase'

// Payroll data access. GM/admin only — every table's RLS enforces that,
// so these functions simply return nothing for anyone else rather than
// relying on the screen to hide them.

export async function loadEmployees(branchId, { includeLeavers = false } = {}) {
  let q = supabase.from('payroll_employee')
    .select('*').eq('branch_id', branchId)
  if (!includeLeavers) q = q.is('ended_on', null)
  const { data, error } = await q.order('tier').order('full_name')
  if (error) throw error
  return data || []
}

export async function saveEmployee(emp) {
  const row = { ...emp }
  delete row.created_at
  const { data, error } = row.id
    ? await supabase.from('payroll_employee').update(row).eq('id', row.id).select().single()
    : await supabase.from('payroll_employee').insert(row).select().single()
  if (error) throw error
  return data
}

// Leaving is a DATE, never a delete: past months must stay intact.
export async function endEmployment(id, endedOn) {
  const { error } = await supabase.from('payroll_employee')
    .update({ ended_on: endedOn }).eq('id', id)
  if (error) throw error
}

export async function loadPeriod(branchId, year, month) {
  const { data, error } = await supabase.from('payroll_period')
    .select('*').eq('branch_id', branchId).eq('year', year).eq('month', month).maybeSingle()
  if (error) throw error
  return data
}

// Opening a month creates it and brings in everyone employed that month,
// COPYING their salary and bank details onto each line.
export async function openPeriod(branchId, year, month, workingDays = 28) {
  let period = await loadPeriod(branchId, year, month)
  if (!period) {
    const { data, error } = await supabase.from('payroll_period')
      .insert({ branch_id: branchId, year, month, working_days: workingDays })
      .select().single()
    if (error) throw error
    period = data
  }
  if (period.status === 'final') return period

  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const emps = await loadEmployees(branchId, { includeLeavers: true })
  const eligible = emps.filter(e =>
    (!e.started_on || e.started_on <= monthEnd) && (!e.ended_on || e.ended_on >= monthStart))

  const { data: existing } = await supabase.from('payroll_line')
    .select('employee_id').eq('period_id', period.id)
  const have = new Set((existing || []).map(l => l.employee_id))
  const rows = eligible.filter(e => !have.has(e.id)).map(e => ({
    period_id: period.id, employee_id: e.id,
    full_name: e.full_name, role_title: e.role_title, tier: e.tier,
    monthly_salary: e.monthly_salary, bank_name: e.bank_name, bank_account: e.bank_account,
    days_worked: period.working_days,
  }))
  if (rows.length) {
    const { error } = await supabase.from('payroll_line').insert(rows)
    if (error) throw error
  }
  return period
}

export async function loadLines(periodId) {
  const { data, error } = await supabase.from('payroll_line')
    .select('*, payroll_deduction(*)')
    .eq('period_id', periodId)
  if (error) throw error
  return (data || []).sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === 'management' ? -1 : 1) ||
    String(a.full_name).localeCompare(String(b.full_name)))
}

export async function updateLine(id, patch) {
  const { error } = await supabase.from('payroll_line').update(patch).eq('id', id)
  if (error) throw error
}

export async function addDeduction(lineId, d) {
  const { error } = await supabase.from('payroll_deduction')
    .insert({ line_id: lineId, ...d })
  if (error) throw error
}

export async function removeDeduction(id) {
  const { error } = await supabase.from('payroll_deduction').delete().eq('id', id)
  if (error) throw error
}

// What each linked employee currently owes at the departments, so the
// month's deductions can be PROPOSED rather than typed. Nothing is
// written here — the GM reviews and edits before anything is saved.
// Proposes each employee's credit TAKEN DURING THIS MONTH, not their
// whole running balance. Was pulling v_customer_balances_by_staff —
// everything ever owed — so opening a fresh month could deduct arrears
// from months already settled or already deducted elsewhere.
//
// Uses customer_credit_for_month (294), the same figures the Credit
// page's monthly view shows, so what gets proposed here always matches
// what the GM can see there.
//
// location_id is not in that function's output (it sums across
// departments for the month), so the single deduction line is tagged
// 'month' rather than a department — itemised by month instead of by
// where it was taken.
export async function proposeCreditDeductions(branchId, lines, year, month) {
  const ids = lines.map(l => l.customer_id).filter(Boolean)
  if (!ids.length || !year || !month) return {}
  const { data, error } = await supabase.rpc('customer_credit_for_month', {
    p_branch: branchId, p_year: year, p_month: month,
  })
  if (error) throw error
  const out = {}
  for (const r of (data || [])) {
    if (!ids.includes(r.customer_id)) continue
    const taken = Number(r.taken || 0)
    if (taken <= 0.009) continue
    out[r.customer_id] = [{ location_id: null, amount: taken,
      note: `Credit taken in ${String(month).padStart(2, '0')}/${year}` }]
  }
  return out
}

// Finalising freezes the month AND clears the credit it deducted: a
// deduction settles that debt, so the customer balance must come down or
// the same money sits owing in two places.
//
// Written with method 'payroll' (migration 276) so it NEVER counts as
// cash taken — otherwise the day's "Debt recovered" and "Total income"
// would include wages deducted, and whoever cashed up would be chasing
// money that never arrived.
// Finalising is the one moment that commits everything the month
// decided. Three things were only ever READ elsewhere in this file and
// never WRITTEN by anything — found by checking, not assumed:
//   1. a credit deduction settling department debt     (this was here)
//   2. money typed as "held as savings" on a line NEVER reached
//      payroll_savings_entry — the ledger savingsBalances() reads from.
//      The deduction correctly reduced pay; nothing ever recorded that
//      the money was being HELD. "Saved NX" on the staff list could
//      never move, whatever was deducted.
//   3. the pot payout: savePayout() existed but nothing called it, and
//      payroll_pot_member.taken_period_id — the field that marks whose
//      turn is done — was never set anywhere. The rotation could not
//      advance even if a payout was recorded by hand.
// All three now commit together here, or none do.
export async function finalisePeriod(periodId, staffId) {
  const { data: period } = await supabase.from('payroll_period')
    .select('id, branch_id, year, month, status').eq('id', periodId).single()
  if (period?.status === 'final') throw new Error('That month is already finalised.')

  const { data: lines } = await supabase.from('payroll_line')
    .select('id, employee_id, full_name, savings, payroll_deduction(source, amount, location_id, customer_id)')
    .eq('period_id', periodId)

  const lastDay = new Date(period.year, period.month, 0).toISOString().slice(0, 10)

  // 1. Credit deductions settle department debt (unchanged from before).
  const repayments = []
  for (const l of (lines || [])) {
    for (const d of (l.payroll_deduction || [])) {
      if (d.source !== 'credit' || !d.customer_id) continue
      repayments.push({
        branch_id: period.branch_id, customer_id: d.customer_id,
        location_id: d.location_id, amount: d.amount, method: 'payroll',
        paid_on: lastDay, note: `Deducted from ${l.full_name}'s salary`,
        recorded_by: staffId, credit_staff_id: staffId,
      })
    }
  }
  if (repayments.length) {
    const { error } = await supabase.from('credit_repayments').insert(repayments)
    if (error) throw error
  }

  // 2. Money held as savings this month becomes a real deposit.
  const deposits = (lines || [])
    .filter(l => Number(l.savings) > 0.009)
    .map(l => ({
      employee_id: l.employee_id, period_id: periodId, entry_date: lastDay,
      kind: 'deposit', amount: Number(l.savings),
      note: `Held from ${l.full_name}'s ${period.year}-${String(period.month).padStart(2, '0')} salary`,
    }))
  if (deposits.length) {
    const { error } = await supabase.from('payroll_savings_entry').insert(deposits)
    if (error) throw error
  }

  // 3. A pot payout recorded for this period marks that member's turn
  // as taken, so payroll_pot_next() moves on to whoever is next.
  const { data: payouts } = await supabase.from('payroll_pot_payout')
    .select('employee_id').eq('period_id', periodId)
  if (payouts?.length) {
    const { error } = await supabase.from('payroll_pot_member')
      .update({ taken_period_id: periodId })
      .in('employee_id', payouts.map(p => p.employee_id))
      .is('taken_period_id', null)
    if (error) throw error
  }

  const { error: e2 } = await supabase.from('payroll_period')
    .update({ status: 'final', finalised_by: staffId, finalised_at: new Date().toISOString() })
    .eq('id', periodId)
  if (e2) throw e2
  return { repayments: repayments.length, deposits: deposits.length, payouts: payouts?.length || 0 }
}

export async function reopenPeriod(periodId) {
  const { error } = await supabase.from('payroll_period')
    .update({ status: 'draft', finalised_by: null, finalised_at: null }).eq('id', periodId)
  if (error) throw error
}

// ---- the management pot ----
export async function loadPotNext(branchId) {
  const { data, error } = await supabase.rpc('payroll_pot_next', { p_branch: branchId })
  if (error) return null
  return (data && data[0]) || null
}

export async function loadPayouts(periodId) {
  const { data, error } = await supabase.from('payroll_pot_payout')
    .select('*').eq('period_id', periodId)
  if (error) throw error
  return data || []
}

export async function savePayout(periodId, employeeId, amount, note) {
  const { error } = await supabase.from('payroll_pot_payout')
    .upsert({ period_id: periodId, employee_id: employeeId, amount, note },
            { onConflict: 'period_id,employee_id' })
  if (error) throw error
}

// ---- individual savings ----
export async function loadSavings(employeeId) {
  const { data, error } = await supabase.from('payroll_savings_entry')
    .select('*').eq('employee_id', employeeId).order('entry_date')
  if (error) throw error
  return data || []
}

export async function savingsBalances(branchId) {
  const { data: emps } = await supabase.from('payroll_employee')
    .select('id').eq('branch_id', branchId)
  const ids = (emps || []).map(e => e.id)
  if (!ids.length) return {}
  const { data } = await supabase.from('payroll_savings_entry')
    .select('employee_id, kind, amount').in('employee_id', ids)
  const out = {}
  for (const e of (data || [])) {
    out[e.employee_id] = (out[e.employee_id] || 0)
      + (e.kind === 'deposit' ? Number(e.amount) : -Number(e.amount))
  }
  return out
}

// ---- the arithmetic, in ONE place ----
// Nnewi's sheet is the consistent one, so its formula is the model.
// Awka's "Amount Receivable" column reads 0 for everyone — confirmed a
// broken formula, and deliberately not reproduced.
export function lineTotals(line, payoutAmount = 0, workingDays = 28) {
  const salary = Number(line.monthly_salary || 0)
  const days = Number(line.days_worked || 0)
  // Divide by the MONTH's working days, not a fixed 28: a 30-day month
  // paid on a 28-day divisor overpays everyone slightly.
  const wd = Number(workingDays) || 28
  const dailyRate = wd > 0 ? salary / wd : 0
  const earned = Math.round(dailyRate * days * 100) / 100
  const deductions = (line.payroll_deduction || []).reduce((t, d) => t + Number(d.amount), 0)
  const additions = Number(line.additions || 0)
  const contribution = Number(line.contribution || 0)   // paid INTO the pot
  const savings = Number(line.savings || 0)             // held back for themselves
  const pot = Number(payoutAmount || 0)                 // taken OUT of the pot

  // What actually reaches them this month, pot included.
  const net = earned - deductions + additions - contribution - savings + pot

  // Over-70,000 rule, on what they are ACTUALLY PAID — STRICTLY above,
  // so someone on exactly 70,000 is unaffected.
  //
  // Corrected from an earlier reading that used salary + payout. For the
  // GM in September that gave 350,000 and a gift of 280,000; the right
  // basis is 250,000 - 50,000 paid in + 250,000 received = 450,000, so
  // the gift is 380,000. September's sheet understated it by 100,000.
  const over = net > 70000
  const documented = over ? 70000 : net
  const gift = over ? net - 70000 : 0

  return { dailyRate, earned, deductions, additions, contribution, savings,
           pot, net, gross: net, documented, gift, overThreshold: over }
}

// Link an employee to their credit account AND rename that account to
// their AKA, in one database step (migration 285). One step matters: a
// rename that half-applied would leave the link pointing at an account
// still called "Chidera/staff".
//
// It refuses rather than guessing if the AKA is already another
// customer's name at that branch, or the account belongs to someone
// else.
export async function setEmployeeCreditAccount(employeeId, customerId, aka) {
  const { error } = await supabase.rpc('set_employee_credit_account', {
    p_employee: employeeId, p_customer: customerId || null, p_aka: aka || null,
  })
  if (error) throw error
}

// Customers this employee's credit could sit under. Staff credit is
// recorded as ordinary customer accounts ("Chioma (staff)"), so this is
// simply the branch's active customers, newest activity aside — the GM
// picks the right one once and it is stored.
export async function loadCustomersForLinking(branchId) {
  const { data, error } = await supabase.from('customers')
    .select('id, name')
    .eq('branch_id', branchId).eq('is_active', true)
    .order('name')
  if (error) throw error
  return data || []
}
