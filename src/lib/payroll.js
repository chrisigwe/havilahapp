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
export async function proposeCreditDeductions(branchId, lines) {
  const ids = lines.map(l => l.customer_id).filter(Boolean)
  if (!ids.length) return {}
  const { data, error } = await supabase.from('v_customer_balances_by_staff')
    .select('customer_id, location_id, balance')
    .eq('branch_id', branchId).in('customer_id', ids)
  if (error) throw error
  const out = {}
  for (const r of (data || [])) {
    if (Number(r.balance) <= 0.009) continue
    ;(out[r.customer_id] || (out[r.customer_id] = []))
      .push({ location_id: r.location_id, amount: Number(r.balance) })
  }
  return out
}

export async function finalisePeriod(periodId, staffId) {
  const { error } = await supabase.from('payroll_period')
    .update({ status: 'final', finalised_by: staffId, finalised_at: new Date().toISOString() })
    .eq('id', periodId)
  if (error) throw error
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
export function lineTotals(line, payoutAmount = 0) {
  const salary = Number(line.monthly_salary || 0)
  const days = Number(line.days_worked || 0)
  const dailyRate = salary / 28
  const earned = Math.round(dailyRate * days * 100) / 100
  const deductions = (line.payroll_deduction || []).reduce((t, d) => t + Number(d.amount), 0)
  const additions = Number(line.additions || 0)
  const contribution = Number(line.contribution || 0)   // paid INTO the pot
  const savings = Number(line.savings || 0)             // held back for themselves
  const net = earned - deductions + additions - contribution - savings

  // Over-70,000 rule, on salary plus what the pot PAID OUT to them this
  // month (confirmed: the GM's 250,000 + 100,000 = 350,000 -> 70,000
  // documented, 280,000 gift).
  const gross = salary + Number(payoutAmount || 0)
  const documented = Math.min(gross, 70000)
  const gift = Math.max(0, gross - 70000)

  return { dailyRate, earned, deductions, additions, contribution, savings, net,
           gross, documented, gift }
}
