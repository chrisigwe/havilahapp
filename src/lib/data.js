import { supabase } from './supabase'
import { lagosDaysAgo, nameKey } from './format'
import { normalizeCustomerName } from './customerName'

export async function loadBranches() {
  const { data, error } = await supabase.from('branches')
    .select('id, slug, name').eq('is_active', true).order('slug')
  if (error) return []
  return data
}

// viewBranchId lets GM/admin work in either branch; everyone else
// is pinned to their own by RLS regardless of what is passed.
//
// Split in two so switching branches doesn't re-run the identity
// check: loadStaffIdentity() (auth + staff row) only needs to run
// once per sign-in, not once per branch switch. loadBranchData()
// is the part that actually changes when the viewed branch changes.
export async function loadStaffIdentity() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return undefined  // no session — distinct from "session but no staff row"
  // accept both identity mappings: explicit auth_user_id link,
  // or innflow-style staff.id === auth uid
  const { data: staff, error } = await supabase
    .from('staff').select('*')
    .or(`auth_user_id.eq.${user.id},id.eq.${user.id}`)
    .eq('is_active', true).limit(1).maybeSingle()
  if (error) throw error
  return staff  // null = session exists but not linked to a staff record
}

export async function loadBranchData(staff, viewBranchId) {
  if (!staff) return { staff: null }
  const seesAllBranches = ['gm', 'admin'].includes(staff.role)
  const b = (seesAllBranches && viewBranchId) ? viewBranchId : staff.branch_id
  const [locs, tiers, methods, items, assigned, branchRow] = await Promise.all([
    supabase.from('stock_locations').select('*').eq('branch_id', b).order('sort_order'),
    supabase.from('branch_price_tiers').select('tier').eq('branch_id', b),
    supabase.from('branch_payment_methods').select('method').eq('branch_id', b),
    supabase.from('stock_items').select('*').eq('branch_id', b).eq('is_active', true).order('name'),
    supabase.from('staff_locations').select('location_id').eq('staff_id', staff.id),
    supabase.from('branches').select('name, slug').eq('id', b).maybeSingle(),
  ])
  for (const r of [locs, tiers, methods, items]) if (r.error) throw r.error

  // Departments this person works. Storekeepers and managers see all;
  // so does anyone with no assignment yet. The store itself is only
  // shown to roles that handle it.
  const OVERSEER = ['storekeeper', 'manager', 'gm', 'admin']
  const mine = new Set((assigned?.data || []).map(r => r.location_id))
  const seesAll = OVERSEER.includes(staff.role) || mine.size === 0
  const visible = seesAll
    ? locs.data
    : locs.data.filter(l => mine.has(l.id))

  // A safe default location for THIS branch: the person's stored
  // default, but only if it actually exists among the locations they
  // can see here. A cross-branch or stale default (e.g. pointing at
  // the other branch's OpenBar) would otherwise blank every stock
  // total until they manually tap a tab — so fall back to their
  // first visible sales point instead.
  const validDefault = visible.some(l => l.id === staff.default_location_id)
    ? staff.default_location_id
    : (visible.find(l => l.is_sales_point && !l.is_store)?.id || visible[0]?.id || null)

  return {
    // pages read staff.branch_id everywhere, so point it at the branch
    // being viewed; realBranchId keeps the person's home branch
    staff: { ...staff, branch_id: b, realBranchId: staff.branch_id,
             default_location_id: validDefault },
    seesAllBranches,
    branchName: branchRow?.data?.name || '',
    viewBranchId: b,
    seesAll,
    allLocations: locs.data,
    locations: visible,
    tiers: tiers.data.map(t => t.tier),
    methods: methods.data.map(m => m.method),
    items: items.data,
  }
}

// kept for anything still calling the combined form directly (sign-in,
// first load) — does the identity check every time, so branch switches
// should call loadBranchData() instead once identity is already known
export async function loadBootstrap(viewBranchId) {
  const staff = await loadStaffIdentity()
  if (staff === undefined) return null
  return loadBranchData(staff, viewBranchId)
}

export async function loadStockMap(branchId) {
  const { data, error } = await supabase
    .from('v_stock_on_hand')
    .select('stock_item_id, location_id, qty_on_hand')
    .eq('branch_id', branchId)
  if (error) throw error
  const map = {}
  for (const r of data) map[`${r.stock_item_id}:${r.location_id}`] = Number(r.qty_on_hand)
  return map
}

// most-sold item ids over the last 14 days, for picker ordering
export async function loadPopular(branchId) {
  const { data, error } = await supabase
    .from('v_item_popularity').select('stock_item_id, qty_sold')
    .eq('branch_id', branchId)
  if (error) throw error
  const c = {}
  for (const r of data) c[r.stock_item_id] = Number(r.qty_sold)
  return c
}

export async function loadToday(branchId, date, locationId) {
  let q = supabase
    .from('sales')
    .select(`id, stock_item_id, description, location_id, tier, qty, unit_price, amount, created_at,
             receipt_id, business_date, recorded_by, on_behalf_of,
             recorder:recorded_by(full_name), stood_in_for:on_behalf_of(full_name),
             sale_payments(method, amount)`)
    .eq('branch_id', branchId).eq('business_date', date)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// Records a basket: one sales row per line, with the basket's payment
// split allocated across those lines in order.
export async function saveBasket({ staff, locationId, lines, payments, date, customerId, backdateReason, receiptId, onBehalfOf }) {
  const receipt = receiptId || crypto.randomUUID()
  const buckets = payments.filter(p => Number(p.amount) > 0)
    .map(p => ({ method: p.method, left: Number(p.amount) }))
  for (const line of lines) {
    const amount = Number((line.qty * line.unitPrice).toFixed(2))
    const { data: sale, error } = await supabase.from('sales').insert({
      branch_id: staff.branch_id,
      business_date: date,
      occurred_at: new Date().toISOString(),
      // typed restaurant orders have no catalog item (a plate of food
      // isn't a countable stock unit) — item is null, description
      // carries the typed text instead
      stock_item_id: line.item?.id || null,
      description: line.item ? null : (line.description || null),
      // a cross-department pick (e.g. a Restaurant item sold at OpenBar)
      // carries its own sourcing location — that's what both the
      // stock deduction AND the daily takings attribute to, so a
      // walk-in food order counts toward Restaurant's figures, not the
      // bar's, per the explicit decision on how that should work
      location_id: line.locationId || locationId,
      tier: line.tier,
      qty: line.qty,
      unit_price: line.unitPrice,
      customer_id: customerId || null,
      backdate_reason: backdateReason || null,
      receipt_id: receipt,
      on_behalf_of: onBehalfOf || null,
      recorded_by: staff.id,
    }).select('id').single()
    if (error) throw error

    let owing = amount
    const rows = []
    for (const b of buckets) {
      if (owing <= 0.001 || b.left <= 0.001) continue
      const take = Math.min(owing, b.left)
      rows.push({ sale_id: sale.id, method: b.method, amount: Number(take.toFixed(2)) })
      b.left -= take; owing -= take
    }
    if (owing > 0.001 && buckets.length) {
      rows.push({ sale_id: sale.id, method: buckets[0].method, amount: Number(owing.toFixed(2)) })
    }
    if (rows.length) {
      const { error: e2 } = await supabase.from('sale_payments').insert(rows)
      if (e2) throw e2
    }
  }
  return receipt
}

export async function saveWriteoff({ staff, item, locationId, kind, qty, unitValue, note, date, damageReason }) {
  const { error } = await supabase.from('stock_movements').insert({
    branch_id: staff.branch_id,
    stock_item_id: item.id,
    movement_type: kind, // 'complimentary' | 'damage'
    from_location: locationId,
    to_location: null,
    qty, unit_cost: unitValue,
    business_date: date,
    occurred_at: new Date().toISOString(),
    recorded_by: staff.id,
    is_migrated: false,
    damage_reason: kind === 'damage' ? (damageReason || null) : null,
    note: note || (kind === 'damage' ? 'damaged' : 'PR / complimentary'),
  })
  if (error) throw error
}

// ---------- corrections (manager / gm / admin only) ----------

// Recent activity across sales and stock movements, newest first.
export async function loadActivity(branchId, days = 14, ownOnlyStaffId = null) {
  // own-only matches app_owns_recent() in the database exactly: today
  // and yesterday, by Lagos calendar date, not a raw 24-hour window
  const since = ownOnlyStaffId ? lagosDaysAgo(1) : lagosDaysAgo(days)
  const own = (q) => ownOnlyStaffId ? q.eq('recorded_by', ownOnlyStaffId) : q
  const [sales, moves] = await Promise.all([
    // a sale recorded on someone's behalf belongs on THEIR list, not
    // the recorder's, so match either column
    (ownOnlyStaffId
      ? supabase.from('sales')
          .select('id, business_date, stock_item_id, description, location_id, tier, qty, unit_price, amount, recorded_by, on_behalf_of, created_at, customers(name)')
          .eq('branch_id', branchId).gte('business_date', since)
          .or(`recorded_by.eq.${ownOnlyStaffId},on_behalf_of.eq.${ownOnlyStaffId}`)
      : supabase.from('sales')
          .select('id, business_date, stock_item_id, description, location_id, tier, qty, unit_price, amount, recorded_by, on_behalf_of, created_at, customers(name)')
          .eq('branch_id', branchId).gte('business_date', since)
    ).order('created_at', { ascending: false }).limit(300),
    own(supabase.from('stock_movements')
      .select('id, business_date, stock_item_id, movement_type, from_location, to_location, qty, unit_cost, note, damage_reason, recorded_by, created_at')
      .eq('branch_id', branchId).gte('business_date', since)
      .is('reference_id', null)          // sale deductions are shown as their sale
      .order('created_at', { ascending: false }).limit(300)),
  ])
  if (sales.error) throw sales.error
  if (moves.error) throw moves.error
  return [
    ...sales.data.map(r => ({ ...r, kind: 'sale' })),
    ...moves.data.map(r => ({ ...r, kind: 'movement' })),
  ].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
}

export async function deleteEntry(entry) {
  if (entry.kind === 'sale') {
    const { error: e1 } = await supabase.from('sale_payments').delete().eq('sale_id', entry.id)
    if (e1) throw e1
    const { error } = await supabase.from('sales').delete().eq('id', entry.id)
    if (error) throw error          // trigger removes the stock deduction
  } else {
    const { error } = await supabase.from('stock_movements').delete().eq('id', entry.id)
    if (error) throw error
  }
}

export async function updateEntry(entry, { qty, unitPrice }) {
  if (entry.kind === 'sale') {
    const { error } = await supabase.from('sales')
      .update({ qty, unit_price: unitPrice }).eq('id', entry.id)
    if (error) throw error          // trigger keeps the deduction in step
    // payments no longer match the new total: restate as a single row
    const { error: e1 } = await supabase.from('sale_payments').delete().eq('sale_id', entry.id)
    if (e1) throw e1
    const { data: pm } = await supabase.from('branch_payment_methods')
      .select('method').eq('branch_id', entry.branch_id ?? undefined).limit(1)
    const method = entry.method || pm?.[0]?.method || 'cash'
    const { error: e2 } = await supabase.from('sale_payments')
      .insert({ sale_id: entry.id, method, amount: qty * unitPrice })
    if (e2) throw e2
  } else {
    const patch = { qty }
    if (unitPrice !== undefined && unitPrice !== null && unitPrice !== '') patch.unit_cost = unitPrice
    const { error } = await supabase.from('stock_movements').update(patch).eq('id', entry.id)
    if (error) throw error
  }
}

export async function loadAudit(branchId, limit = 100) {
  const { data, error } = await supabase
    .from('inventory_audit')
    .select('id, happened_at, action, entity, summary, done_by_name, business_date')
    .eq('branch_id', branchId)
    .order('happened_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}

// ---------- daily financials: one round trip, not four ----------
// Replaces the old loadReconciliation + loadDailySummary pair, which
// each fired their own Promise.all internally — four separate
// requests total, all genuinely concurrent already, so combining
// them in JS alone would have changed nothing. This calls one
// database function that computes everything server-side instead.
export async function loadDailyFinancials(branchId, date, locationId) {
  const { data, error } = await supabase.rpc('get_daily_financials', {
    p_branch: branchId, p_date: date, p_location: locationId || null,
  })
  if (error) throw error
  return {
    byMethod: data.byMethod || {},
    nonRevenue: data.nonRevenue || [],
    grossSales: Number(data.grossSales || 0),
    received: Number(data.received || 0),
    creditRaised: Number(data.creditRaised || 0),
    debtRecovered: Number(data.debtRecovered || 0),
    recoveredBy: data.recoveredBy || {},
    totalMoneyIn: Number(data.totalMoneyIn || 0),
  }
}

export async function loadVariances(branchId, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('v_sale_variances')
    .select('sale_id, business_date, item_name, qty, unit_price, expected, allocated, difference, recorded_by_name')
    .eq('branch_id', branchId).gte('business_date', since)
    .order('business_date', { ascending: false })
  if (error) throw error
  return data
}

export async function loadOpeningDate(branchId) {
  const { data, error } = await supabase.from('branches')
    .select('opening_balance_date').eq('id', branchId).maybeSingle()
  if (error) return null
  return data?.opening_balance_date || null
}



// ---------- customers & credit ----------
export async function loadCustomers(branchId) {
  const { data, error } = await supabase.from('customers')
    .select('id, name, phone, served_by').eq('branch_id', branchId)
    .eq('is_active', true).order('name')
  if (error) throw error
  return data
}

export async function createCustomer(branchId, name, servedBy) {
  const { data, error } = await supabase.from('customers')
    .insert({ branch_id: branchId, name: name.trim(), served_by: servedBy || null })
    .select('id, name, served_by').single()
  if (error) {
    // the unique index caught a duplicate spelling — reuse the record
    // that already exists instead of failing the sale
    if (String(error.code) === '23505') {
      const { data: found } = await supabase.from('customers')
        .select('id, name, served_by').eq('branch_id', branchId)
        .eq('name_key', normalizeCustomerName(name)).maybeSingle()
      if (found) return found
    }
    throw error
  }
  return data
}

// staffId narrows to one person's debtors; RLS already hides other
// people's rows from bar staff, so this is for managers filtering
export async function loadBalances(branchId, locationId, staffId) {
  let q = supabase.from('v_customer_balances_by_staff')
    .select('customer_id, location_id, staff_id, staff_name, name, phone, served_by, credit_taken, repaid, balance, first_credit_date, last_credit_date')
    .eq('branch_id', branchId)
  if (locationId) q = q.eq('location_id', locationId)
  if (staffId) q = q.eq('staff_id', staffId)
  const { data, error } = await q.order('balance', { ascending: false })
  if (error) throw error
  return data
}

export async function loadCustomerLedger(branchId, customerId, locationId, staffId) {
  let sq = supabase.from('sales')
    .select('id, business_date, qty, unit_price, stock_item_id, description, location_id, tier, sale_payments(method, amount)')
    .eq('branch_id', branchId).eq('customer_id', customerId)
  let rq = supabase.from('credit_repayments')
    .select('id, paid_on, method, amount, note, location_id')
    .eq('branch_id', branchId).eq('customer_id', customerId)
  if (locationId) { sq = sq.eq('location_id', locationId); rq = rq.eq('location_id', locationId) }
  if (staffId) {
    sq = sq.or(`recorded_by.eq.${staffId},on_behalf_of.eq.${staffId}`)
    rq = rq.eq('credit_staff_id', staffId)
  }
  const [sales, repays] = await Promise.all([
    sq.order('business_date', { ascending: false }),
    rq.order('paid_on', { ascending: false }),
  ])
  if (sales.error) throw sales.error
  if (repays.error) throw repays.error
  const credit = sales.data
    .map(s => ({ ...s, credit: (s.sale_payments || [])
      .filter(p => p.method === 'credit')
      .reduce((a, p) => a + Number(p.amount), 0) }))
    .filter(s => s.credit > 0)
  return { credit, repayments: repays.data }
}

export async function saveRepayment({ staff, customerId, amount, method, paidOn, note, locationId, creditStaffId }) {
  const { error } = await supabase.from('credit_repayments').insert({
    branch_id: staff.branch_id, customer_id: customerId, location_id: locationId || null,
    credit_staff_id: creditStaffId || staff.id,
    amount, method, paid_on: paidOn, note: note || null, recorded_by: staff.id,
  })
  if (error) throw error
}

// ---------- stock counts ----------
export async function loadCounts(branchId) {
  const { data, error } = await supabase.from('stock_counts')
    .select(`id, count_date, status, location_id, counted_by, verified_by, submitted_at, verified_at, note,
             counter:counted_by(full_name), verifier:verified_by(full_name)`)
    .eq('branch_id', branchId).order('created_at', { ascending: false }).limit(40)
  if (error) throw error
  return data
}

export async function loadCountLines(countId) {
  const { data, error } = await supabase.from('stock_count_lines')
    .select('stock_item_id, system_qty, counted_qty, auditor_adjusted').eq('count_id', countId)
  if (error) throw error
  return data
}

export async function saveCountLine(countId, itemId, qty) {
  const { error } = await supabase.from('stock_count_lines')
    .update({ counted_qty: qty }).eq('count_id', countId).eq('stock_item_id', itemId)
  if (error) throw error
}

export async function submitCount(countId) {
  const { error } = await supabase.rpc('submit_stock_count', { p_count: countId })
  if (error) throw error
}

export async function startCountOfType({ staff, locationId, stockMap, items, countType, countDate }) {
  const { data: count, error } = await supabase.from('stock_counts').insert({
    branch_id: staff.branch_id, location_id: locationId,
    counted_by: staff.id, status: 'draft',
    count_type: countType, count_date: countDate,
  }).select('id').single()
  if (error) throw error
  const lines = items.map(i => ({
    count_id: count.id, stock_item_id: i.id,
    system_qty: stockMap[`${i.id}:${locationId}`] ?? 0, counted_qty: null,
  }))
  const { error: e2 } = await supabase.from('stock_count_lines').insert(lines)
  if (e2) throw e2
  return count.id
}

export async function postOpeningBalance(countId) {
  const { error } = await supabase.rpc('post_opening_balance', { p_count: countId })
  if (error) throw error
}

export async function verifyCount(countId) {
  const { error } = await supabase.rpc('verify_stock_count', { p_count: countId })
  if (error) throw error
}

export async function deleteCount(countId) {
  const { error: e1 } = await supabase.from('stock_count_lines').delete().eq('count_id', countId)
  if (e1) throw e1
  const { error } = await supabase.from('stock_counts').delete().eq('id', countId)
  if (error) throw error
}


// ---------- catalog ----------
export async function loadAllCatalogItems(branchId) {
  const { data, error } = await supabase.from('stock_items')
    .select('*').eq('branch_id', branchId).order('name')
  if (error) throw error
  return data
}

export async function deleteCatalogItem(itemId) {
  const { error } = await supabase.rpc('delete_stock_item', { p_item: itemId })
  if (error) throw error
}

export async function saveItemPrices(itemId, patch) {
  const { error } = await supabase.from('stock_items').update(patch).eq('id', itemId)
  if (error) throw error
}

export async function createItem(branchId, fields) {
  // code has a per-branch unique constraint and is auto-generated
  // (no longer user-entered), so on the rare chance of a collision,
  // retry once with a fresh suffix rather than surface a constraint
  // error the person can't act on
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.from('stock_items')
      .insert({ branch_id: branchId, ...fields }).select('*').single()
    if (!error) return data
    const isDup = error.code === '23505' || /duplicate|unique/i.test(error.message || '')
    if (isDup && attempt === 0) {
      fields = { ...fields, code: (fields.code || 'ITEM').split('-')[0]
        + '-' + Math.random().toString(36).slice(2, 6).toUpperCase() }
      continue
    }
    throw error
  }
}

// ---------- split-payment aware corrections ----------
export async function loadSalePayments(saleId) {
  const { data, error } = await supabase.from('sale_payments')
    .select('id, method, amount').eq('sale_id', saleId)
  if (error) throw error
  return data
}

export async function updateSaleWithPayments(saleId, { qty, unitPrice, payments }) {
  const { error } = await supabase.from('sales')
    .update({ qty, unit_price: unitPrice }).eq('id', saleId)
  if (error) throw error
  const { error: e1 } = await supabase.from('sale_payments').delete().eq('sale_id', saleId)
  if (e1) throw e1
  const rows = payments.filter(p => Number(p.amount) > 0)
    .map(p => ({ sale_id: saleId, method: p.method, amount: Number(p.amount) }))
  if (rows.length) {
    const { error: e2 } = await supabase.from('sale_payments').insert(rows)
    if (e2) throw e2
  }
}

export async function loadRecovery(branchId, locationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  let q = supabase.from('v_debt_recovery')
    .select('id, paid_on, method, amount, note, customer_name, location_name, recovered_by_name, credit_staff_name, location_id, first_credit_date, last_credit_date')
    .eq('branch_id', branchId).gte('paid_on', since)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q.order('paid_on', { ascending: false })
  if (error) throw error
  return data
}

// Editing an already-recorded repayment — Auditor/Admin/Manager/GM
// only (enforced by RLS regardless of what the UI shows).
export async function updateRepayment(id, patch) {
  const { error } = await supabase.from('credit_repayments')
    .update(patch).eq('id', id)
  if (error) throw error
}

export async function saveMovements(rows) {
  const { error } = await supabase.from('stock_movements').insert(rows)
  if (error) throw error
}


// ---------- receipts ----------
export async function loadReceipt(receiptId) {
  const { data, error } = await supabase.from('sales')
    .select(`id, business_date, qty, unit_price, tier, stock_item_id, description, location_id,
             customer_id, recorded_by, created_at,
             sale_payments(method, amount),
             customers(name, phone),
             stock_items(name),
             staff:recorded_by(full_name)`)
    .eq('receipt_id', receiptId)
    .order('created_at')
  if (error) throw error
  return data
}

// people who record sales at this branch, for the manager's filter
// Staff who work a specific location — for "recording on behalf of".
// A person with NO staff_locations rows sees every department (same
// rule the app uses everywhere else), so they show up regardless of
// which location is passed in; someone assigned elsewhere does not.
export async function loadStaffForLocation(branchId, locationId) {
  const { data, error } = await supabase.from('staff')
    .select(`id, full_name, role, staff_locations(location_id)`)
    .eq('branch_id', branchId).eq('is_active', true)
    .in('role', ['bar', 'front_desk'])
    .order('full_name')
  if (error) return []
  return data
    .filter(s => !locationId || !s.staff_locations.length
                 || s.staff_locations.some(l => l.location_id === locationId))
    .map(({ staff_locations, ...s }) => s)
}

export async function loadBarStaff(branchId) {
  const { data, error } = await supabase.from('staff')
    .select('id, full_name, role').eq('branch_id', branchId).eq('is_active', true)
    .order('full_name')
  if (error) return []
  return data
}

export async function deleteCustomer(customerId) {
  const { error } = await supabase.rpc('delete_customer', { p_customer: customerId })
  if (error) throw error
}

export async function deactivateCustomer(customerId) {
  const { error } = await supabase.from('customers')
    .update({ is_active: false }).eq('id', customerId)
  if (error) throw error
}

// what a department has received from the store — transfers and
// issues, newest first. Used on the Store screen's history section.
export async function loadDepartmentHistory(branchId, locationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`business_date, qty, received_by, movement_type, created_at,
             stock_items(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('to_location', locationId)
    .in('movement_type', ['transfer', 'issue'])
    .gte('business_date', since)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(150)
  if (error) throw error
  return data
}

// Receive (IN): stock arriving into the store from suppliers.
export async function loadReceiveHistory(branchId, storeId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`business_date, qty, received_by, created_at,
             stock_items(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('to_location', storeId)
    .eq('movement_type', 'restock')
    .gte('business_date', since)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(150)
  if (error) throw error
  return data
}

// Move Between Depts: transfers leaving a specific department for
// another (filtered by the FROM department, since that's what the
// user picks first in Move mode).
export async function loadMoveHistory(branchId, fromLocationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`business_date, qty, received_by, created_at, from_location, to_location,
             stock_items(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('from_location', fromLocationId)
    .eq('movement_type', 'transfer')
    .gte('business_date', since)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(150)
  if (error) throw error
  return data
}

// Convert: conversions at a specific department. A conversion is two
// linked rows (one out, one in) sharing a note; we show the "in"
// side (to_location set) so each conversion appears once with its
// produced item, and the note carries the full "X → Y" detail.
export async function loadConvertHistory(branchId, locationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`business_date, qty, note, created_at,
             stock_items(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('to_location', locationId)
    .eq('movement_type', 'conversion')
    .gte('business_date', since)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(150)
  if (error) throw error
  return data
}

// how many counts are sitting in 'submitted', waiting on an auditor —
// used for the in-app badge shown to auditor/storekeeper/manager/gm/admin
export async function loadPendingVerifications(branchId) {
  const { count, error } = await supabase.from('stock_counts')
    .select('id', { count: 'exact', head: true })
    .eq('branch_id', branchId).eq('status', 'submitted')
  if (error) return 0
  return count || 0
}

// Draft counts — started but never submitted. These are the classic
// "incomplete task left rotting" case: someone began a count and
// walked away. Returns who started each and how long ago, so the
// banner can name it. Scoped by RLS, so a bar hand only sees their
// own drafts; a manager/gm sees the branch's.
export async function loadUnfinishedCounts(branchId) {
  const { data, error } = await supabase.from('stock_counts')
    .select('id, location_id, count_date, counted_by, created_at, counter:counted_by(full_name)')
    .eq('branch_id', branchId).eq('status', 'draft')
    .order('created_at', { ascending: true })
  if (error) return []
  return data || []
}

// Auditor corrects one line of a submitted count before verifying —
// overwrites the counted quantity and flags the line as
// auditor-adjusted. Only works on a submitted (not verified) count,
// enforced in the database function.
export async function auditorAdjustCountLine(countId, itemId, qty) {
  const { error } = await supabase.rpc('auditor_adjust_count_line', {
    p_count: countId, p_item: itemId, p_qty: qty,
  })
  if (error) throw error
}

// ---------- Reception & Order: charging items to a hotel room ----------
// Shares the front-desk app's schema (stays/orders/order_items) in the
// same Supabase project — not a separate system. RLS on those tables
// is already open to any authenticated staff on their own branch, so
// no new security is needed here, only the queries themselves.

// Live stays (reserved/occupied) matching a room number or guest name.
export async function searchLiveStays(branchId, query) {
  const q = (query || '').trim()
  let req = supabase.from('stays')
    .select(`id, status, check_in_date, scheduled_out,
             guests(full_name, phone), rooms(room_number)`)
    .eq('branch_id', branchId)
    .in('status', ['reserved', 'occupied'])
    .order('check_in_date', { ascending: false })
    .limit(30)
  const { data, error } = await req
  if (error) throw error
  if (!q) return data
  const needle = q.toLowerCase()
  return data.filter(s =>
    s.rooms?.room_number?.toLowerCase().includes(needle) ||
    s.guests?.full_name?.toLowerCase().includes(needle) ||
    s.guests?.phone?.includes(q))
}

// One item charged to a room = one order + one order_item, matching
// exactly how the front-desk's own folio drawer adds a charge — so a
// room's bill looks identical whether it was added there or from a
// bar's till here. location_id is what the new stock-decrement
// trigger (108b) uses to know which department's stock to pull from;
// category is inferred from that same location's name.
// item + locationId for a catalog pick (drinks/minimart, real stock);
// OR description (no item, no locationId) for a typed restaurant
// order — always category 'food', no stock link, matching how
// walk-in restaurant orders work in the normal Sales flow.
export async function chargeItemToRoom({ staff, stayId, item, locationId, locationName,
                                          description, qty, unitPrice, businessDate }) {
  const category = item
    ? (/restaurant/i.test(locationName || '') ? 'food'
       : /minimart/i.test(locationName || '') ? 'minimart' : 'drink')
    : 'food'
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    settlement: 'charged_to_room', served_by: staff.id,
  }).select('id').single()
  if (oErr) throw oErr
  const { error: iErr } = await supabase.from('order_items').insert({
    order_id: order.id, category,
    stock_item_id: item?.id || null, location_id: item ? locationId : null,
    description: item ? item.name : description, qty, unit_price: unitPrice,
  })
  if (iErr) {
    await supabase.from('orders').delete().eq('id', order.id)
    throw iErr
  }
  return order.id
}

// ---------- Room Board — read-only view of every room's live status ----------
// v_occupancy_today lives in the same shared schema as the room-charge
// tables. Columns confirmed directly against the live database before
// building this, not inferred from the front-desk app's own code.
export async function loadOccupancy(branchId) {
  const { data, error } = await supabase.from('v_occupancy_today')
    .select('*').eq('branch_id', branchId)
  if (error) throw error
  return (data || []).sort((a, b) =>
    String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

// ---------- Check-in & new bookings ----------
// Same shared front-desk schema as Room Board and room charges —
// stays/guests/rooms/room_categories, confirmed directly against the
// live database (constraints, generated columns, RLS) before writing
// any of this, not inferred from the reference app's frontend code.

export async function loadFreeRooms(branchId) {
  const [{ data: occ, error: e1 }, { data: rooms, error: e2 }] = await Promise.all([
    supabase.from('v_occupancy_today').select('room_id')
      .eq('branch_id', branchId).is('stay_id', null).eq('out_of_service', false),
    supabase.from('rooms')
      .select('id, room_number, rate_standard, rate_alternate, rate_short, room_categories(name)')
      .eq('branch_id', branchId).eq('is_active', true),
  ])
  if (e1) throw e1
  if (e2) throw e2
  const freeIds = new Set((occ || []).map(r => r.room_id))
  return (rooms || []).filter(r => freeIds.has(r.id))
    .sort((a, b) => String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

export async function loadBranchStaySettings(branchId) {
  const { data, error } = await supabase.from('branches')
    .select('allowed_cycles, label_rate_standard, label_rate_alternate, label_rate_short')
    .eq('id', branchId).maybeSingle()
  if (error) throw error
  return {
    allowedCycles: data?.allowed_cycles || null,
    rateLabels: {
      standard: data?.label_rate_standard || 'Standard',
      alternate: data?.label_rate_alternate || 'Discounted',
      short: data?.label_rate_short || 'Short-time',
    },
  }
}

// Same guest-matching rule as the reference front-desk app: same
// phone at the same branch is the same person; failing that, the
// same normalized name (so "Mr. Alphonso" and "alphonso" match)
// reuses the existing record rather than creating a duplicate, and
// backfills a phone number the earlier visit didn't capture.
export async function findOrCreateGuest(branchId, name, phone) {
  const digits = (phone || '').replace(/\D/g, '')
  if (digits) {
    const { data: existing } = await supabase.from('guests')
      .select('id').eq('branch_id', branchId).eq('phone_norm', digits).maybeSingle()
    if (existing?.id) return existing.id
  }
  const key = nameKey(name)
  if (key) {
    const { data: byName } = await supabase.from('guests')
      .select('id, phone').eq('branch_id', branchId).eq('name_key', key)
      .order('created_at').limit(1)
    if (byName?.length) {
      if (digits && !byName[0].phone) {
        await supabase.from('guests').update({ phone: phone.trim() }).eq('id', byName[0].id)
      }
      return byName[0].id
    }
  }
  const { data: created, error } = await supabase.from('guests')
    .insert({ branch_id: branchId, full_name: name.trim(), phone: phone?.trim() || null })
    .select('id').single()
  if (error) throw error
  return created.id
}

export async function createStay({ staff, guestId, roomId, rateType, dailyRate,
                                    reserve, billingCycle, checkIn, scheduledOut }) {
  const { error } = await supabase.from('stays').insert({
    branch_id: staff.branch_id, guest_id: guestId, room_id: roomId,
    rate_applied: rateType, daily_rate: dailyRate,
    status: reserve ? 'reserved' : 'occupied',
    billing_cycle: billingCycle, check_in_date: checkIn, scheduled_out: scheduledOut,
    created_by: staff.id,
  })
  if (error) throw error
}
