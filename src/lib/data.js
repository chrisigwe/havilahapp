import { supabase } from './supabase'
import { lagosDaysAgo, lagosToday, nameKey } from './format'
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
             receipt_id, business_date, recorded_by, on_behalf_of, order_type, damage_reason, writeoff_note, pr_meal,
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
      // only ever non-'standard' for a typed Staff order carried
      // through the basket — every other line (the vast majority)
      // gets the column's own default
      order_type: line.orderType || 'standard',
      writeoff_note: line.writeoffNote || null,
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
export async function loadActivity(branchId, days = 14, ownOnlyStaffId = null, locationId = null) {
  // own-only matches app_owns_recent() in the database exactly: today
  // and yesterday, by Lagos calendar date, not a raw 24-hour window
  const since = ownOnlyStaffId ? lagosDaysAgo(1) : lagosDaysAgo(days)
  const own = (q) => ownOnlyStaffId ? q.eq('recorded_by', ownOnlyStaffId) : q
  // a movement's "location" is from_location OR to_location, same
  // convention rowLocationId already uses for display — filtering by
  // department has to match either side, not one fixed column
  const atLocation = (q, col) => locationId
    ? (col === 'sale' ? q.eq('location_id', locationId)
                       : q.or(`from_location.eq.${locationId},to_location.eq.${locationId}`))
    : q
  const [sales, moves] = await Promise.all([
    // a sale recorded on someone's behalf belongs on THEIR list, not
    // the recorder's, so match either column
    atLocation(
      (ownOnlyStaffId
        ? supabase.from('sales')
            .select('id, business_date, stock_item_id, description, location_id, tier, qty, unit_price, amount, recorded_by, on_behalf_of, created_at, customers(name)')
            .eq('branch_id', branchId).gte('business_date', since)
            .or(`recorded_by.eq.${ownOnlyStaffId},on_behalf_of.eq.${ownOnlyStaffId}`)
        : supabase.from('sales')
            .select('id, business_date, stock_item_id, description, location_id, tier, qty, unit_price, amount, recorded_by, on_behalf_of, created_at, customers(name)')
            .eq('branch_id', branchId).gte('business_date', since)
      ), 'sale'
    ).order('created_at', { ascending: false }).limit(300),
    atLocation(own(supabase.from('stock_movements')
      .select('id, business_date, stock_item_id, movement_type, from_location, to_location, qty, unit_cost, note, damage_reason, recorded_by, created_at')
      .eq('branch_id', branchId).gte('business_date', since)
      .is('reference_id', null)          // sale deductions are shown as their sale
      ), 'movement').order('created_at', { ascending: false }).limit(300),
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
  // Most recent credit activity first — applies uniformly across
  // every department's view, since they all call this same function.
  const { data, error } = await q.order('last_credit_date', { ascending: false })
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

// Deleting one — narrower than editing: Admin/GM only, enforced by
// its own RLS policy (repay_remove), confirmed and narrowed
// specifically for this rather than assumed to already match.
export async function deleteRepayment(id) {
  const { error } = await supabase.from('credit_repayments').delete().eq('id', id)
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
             guests!guest_id(full_name, phone), rooms(room_number)`)
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
                                          description, qty, unitPrice, businessDate,
                                          orderType, writeoffNote }) {
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
    order_type: orderType === 'staff' ? 'staff' : 'standard', writeoff_note: writeoffNote || null,
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

// A room is available for a REQUESTED date range if no existing
// reserved/occupied stay on it overlaps that range — not "no stay at
// all", which is what made any future reservation block a room for
// every night before it too. Mirrors the DB constraint's own logic:
// an occupied stay blocks indefinitely (open-ended, since an
// overstay means we don't actually know when it ends), a reserved
// stay only blocks its own planned window.
// A room is available for a REQUESTED date range if no existing
// reserved/occupied stay on it overlaps that range — not "no stay at
// all", which is what made any future reservation block a room for
// every night before it too. Mirrors the DB constraint's own logic
// (daterange(check_in_date, scheduled_out)), with one addition the
// constraint itself can't make: an occupied stay whose scheduled_out
// has already passed (an overstay, not yet checked out) still needs
// to block at least through today, even though its stored
// scheduled_out says otherwise — this app-side check can compare
// against "today" dynamically; a database constraint can't.
export async function loadFreeRooms(branchId, checkIn, scheduledOut) {
  const [{ data: liveStays, error: e1 }, { data: rooms, error: e2 }] = await Promise.all([
    supabase.from('stays')
      .select('room_id, status, check_in_date, scheduled_out')
      .eq('branch_id', branchId).in('status', ['reserved', 'occupied']),
    supabase.from('rooms')
      .select('id, room_number, rate_standard, rate_alternate, rate_short, out_of_service, room_categories(name)')
      .eq('branch_id', branchId).eq('is_active', true),
  ])
  if (e1) throw e1
  if (e2) throw e2

  const today = new Date(lagosToday())
  const reqStart = new Date(checkIn), reqEnd = new Date(scheduledOut)
  const blockedRoomIds = new Set()
  for (const s of liveStays || []) {
    const start = new Date(s.check_in_date)
    let end = new Date(s.scheduled_out)
    if (s.status === 'occupied' && end <= today) end = new Date(today.getTime() + 864e5)   // still blocks at least through today
    const overlaps = start < reqEnd && reqStart < end
    if (overlaps) blockedRoomIds.add(s.room_id)
  }

  return (rooms || [])
    .filter(r => !r.out_of_service && !blockedRoomIds.has(r.id))
    .sort((a, b) => String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

export async function loadBranchStaySettings(branchId) {
  const { data, error } = await supabase.from('branches')
    .select('allowed_cycles, label_rate_standard, label_rate_alternate, label_rate_short, overstay_fee')
    .eq('id', branchId).maybeSingle()
  if (error) throw error
  return {
    allowedCycles: data?.allowed_cycles || null,
    overstayDefault: data?.overstay_fee != null ? Number(data.overstay_fee) : null,
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
// A lightweight "similar guests already exist" search, so staff
// typing a slightly different spelling (Alphonso vs Alphonsus) sees
// the existing guest instead of silently creating a duplicate. Plain
// substring match — this app's guest list is small enough that it
// doesn't need real fuzzy matching, and a simple ILIKE reliably
// catches the shared-prefix misspellings that actually happen in
// practice.
export async function searchSimilarGuests(branchId, query) {
  const q = query.trim()
  if (q.length < 3) return []
  const { data, error } = await supabase.from('guests')
    .select('id, full_name, phone')
    .eq('branch_id', branchId).ilike('full_name', `%${q}%`)
    .order('full_name').limit(5)
  if (error) return []
  return data || []
}

// For the merge-guests tool — same substring search as above, but
// also returns each guest's stay count, so staff can see at a
// glance which record has the real history worth keeping.
export async function searchGuestsForMerge(branchId, query) {
  const q = query.trim()
  if (q.length < 2) return []
  const { data, error } = await supabase.from('guests')
    .select('id, full_name, phone, stays!guest_id(count)')
    .eq('branch_id', branchId).ilike('full_name', `%${q}%`)
    .order('full_name').limit(10)
  if (error) return []
  return (data || []).map(g => ({ ...g, stayCount: g.stays?.[0]?.count ?? 0 }))
}

export async function mergeGuests(survivorId, duplicateIds) {
  const { error } = await supabase.rpc('merge_guests', {
    survivor_id: survivorId, duplicate_ids: duplicateIds,
  })
  if (error) throw error
}

// Option B — bridges the workaround customer-credit system to a
// guest's real, stable identity, now that guest dedup means one
// guest is one clean record. Linked to guests, not a specific stay,
// so the connection survives checkout and any future re-checkin.
export async function linkCustomerToGuest(customerId, guestId) {
  const { error } = await supabase.from('customers')
    .update({ linked_guest_id: guestId }).eq('id', customerId)
  if (error) throw error
}

export async function loadGuestDepartmentCredit(guestId) {
  if (!guestId) return []
  const { data, error } = await supabase.from('v_guest_department_credit')
    .select('location_id, location_name, balance')
    .eq('guest_id', guestId)
  if (error) return []
  return data || []
}

// Other stays whose bill_to_guest_id points at this guest — the
// structured half of Bill To (see createStay/updateStayDetails).
// Only stays with a real outstanding balance are worth surfacing;
// an already-settled one billed-to someone doesn't need chasing.
export async function loadBilledToYou(guestId) {
  if (!guestId) return []
  const { data: stays, error: e1 } = await supabase.from('stays')
    .select('id, guests!guest_id(full_name), rooms(room_number)')
    .eq('bill_to_guest_id', guestId)
  if (e1 || !stays?.length) return []

  const { data: folios, error: e2 } = await supabase.from('v_stay_folio')
    .select('stay_id, outstanding').in('stay_id', stays.map(s => s.id)).gt('outstanding', 0.009)
  if (e2) return []
  const folioByStay = Object.fromEntries((folios || []).map(f => [f.stay_id, f]))

  return stays
    .filter(s => folioByStay[s.id])
    .map(s => ({
      stay_id: s.id, guest_name: s.guests?.full_name, room_number: s.rooms?.room_number,
      outstanding: Number(folioByStay[s.id].outstanding),
    }))
}

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
                                    reserve, billingCycle, checkIn, scheduledOut, billTo, billToGuestId }) {
  const { error } = await supabase.from('stays').insert({
    branch_id: staff.branch_id, guest_id: guestId, room_id: roomId,
    rate_applied: rateType, daily_rate: dailyRate,
    status: reserve ? 'reserved' : 'occupied',
    billing_cycle: billingCycle, check_in_date: checkIn, scheduled_out: scheduledOut,
    created_by: staff.id, bill_to: billTo || null, bill_to_guest_id: billToGuestId || null,
  })
  if (error) throw error
}

// ---------- Folio, payments, checkout ----------
// Same verified-not-inferred discipline as check-in. checkout itself
// has no special trigger (any staff on the branch can check a live
// stay out); reopening one is genuinely enforced server-side by
// enforce_checkout_reversal() — same-day undo is open to anyone
// active, an older one needs manager/gm/admin. This app's own
// prediction of canReopen mirrors that trigger exactly so the button
// doesn't invite an attempt that's certain to fail, but the trigger
// is what actually protects it either way.

export async function loadFolio(stayId) {
  const [{ data: orders, error: e1 }, { data: payments, error: e2 }, { data: folio, error: e3 },
         { data: stay, error: e4 }] = await Promise.all([
    supabase.from('orders')
      .select('id, business_date, served_by, order_items(id, category, description, qty, unit_price, amount, order_type, damage_reason, writeoff_note, pr_meal)')
      .eq('stay_id', stayId).order('business_date', { ascending: false }),
    supabase.from('payments')
      .select('id, business_date, method, amount, is_overstay, remark')
      .eq('stay_id', stayId).order('business_date', { ascending: false }),
    supabase.from('v_stay_folio').select('*').eq('stay_id', stayId).maybeSingle(),
    // v_stay_folio has daily_rate/billing_cycle but not the raw
    // overstay_fee or rate_applied (the rate type) — both needed to
    // pre-fill the editing form correctly.
    supabase.from('stays').select('overstay_fee, rate_applied, bill_to, bill_to_guest_id, guest_id').eq('id', stayId).maybeSingle(),
  ])
  if (e1) throw e1
  if (e2) throw e2
  if (e3) throw e3
  if (e4) throw e4
  // Option B — department credit recorded through the workaround
  // customer system, for departments that linked their customer
  // record to this same guest. Kept as a clearly separate figure,
  // never folded into total_due — a room bill and department credit
  // settle through completely different mechanisms (room payments
  // vs credit_repayments), and conflating them would be misleading
  // for reconciliation even though they're the same person's debt.
  const [departmentCredit, billedToYou] = await Promise.all([
    loadGuestDepartmentCredit(stay?.guest_id),
    loadBilledToYou(stay?.guest_id),
  ])
  return { orders: orders || [], payments: payments || [], folio: folio || null, stay: stay || null,
           departmentCredit, billedToYou }
}

// A guest paying part POS and part cash (or transfer) is one
// settlement but several tenders in the ledger — same split-row
// pattern as Credit's split repayments. parts is [{method, amount}],
// already filtered to non-zero entries by the caller.
export async function recordStayPayment({ staff, stayId, businessDate, cycle, parts, isOverstay }) {
  const rows = parts.filter(p => Number(p.amount) > 0).map(p => ({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    method: p.method, amount: Number(p.amount), is_overstay: !!isOverstay, cycle,
    received_by: staff.id,
  }))
  if (!rows.length) return
  const { error } = await supabase.from('payments').insert(rows)
  if (error) throw error
}

export async function checkOutStay(stayId, actualOut) {
  const { error } = await supabase.from('stays')
    .update({ status: 'checked_out', actual_out: actualOut, updated_at: new Date().toISOString() })
    .eq('id', stayId)
  if (error) throw error
}

// Deliberately minimal — the trigger (enforce_checkout_reversal) sets
// reopened_by/reopened_at/reopen_count and clears actual_out on its
// own; sending anything more here would just be overwritten anyway.
export async function reopenStay(stayId) {
  const { error } = await supabase.from('stays').update({ status: 'occupied' }).eq('id', stayId)
  if (error) throw error
}

// ---------- Closing the two Folio gaps: reopen search, rate/overstay editing ----------

// Checked-out stays don't appear in v_occupancy_today (a checked-out
// room just reverts to vacant there), so reopening one needs its own
// search against stays directly — same shape as CheckIn's room search
// and RoomChargeSheet's guest search. Limited to a recent window so
// the list stays short and relevant; genuinely old stays are a
// data-correction job, not a same-day "undo".
export async function searchRecentCheckouts(branchId, query) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stays')
    .select(`id, check_in_date, scheduled_out, actual_out,
             rooms(room_number), guests!guest_id(full_name)`)
    .eq('branch_id', branchId).eq('status', 'checked_out')
    .gte('actual_out', since)
    .order('actual_out', { ascending: false }).limit(30)
  if (error) throw error
  if (!query) return data
  const needle = query.toLowerCase()
  return data.filter(s =>
    s.rooms?.room_number?.toLowerCase().includes(needle) ||
    s.guests?.full_name?.toLowerCase().includes(needle))
}

// Deliberately minimal, same reasoning as reopenStay — the trigger
// (stamp_rate_adjustment) stamps who and when on its own if daily_rate
// changed; sending it here would just be overwritten.
export async function updateStayDetails({ stayId, dailyRate, billingCycle, scheduledOut, rateReason, billTo, billToGuestId }) {
  const { error } = await supabase.from('stays').update({
    daily_rate: dailyRate, billing_cycle: billingCycle,
    scheduled_out: scheduledOut, rate_reason: rateReason || null,
    bill_to: billTo || null, bill_to_guest_id: billToGuestId || null,
  }).eq('id', stayId)
  if (error) throw error
}

// Same reasoning again — enforce_overstay_fee stamps overstay_set_by/
// at itself, and is the actual enforcement of who can set a
// non-default amount or remove one; this just sends the value.
export async function updateOverstayFee(stayId, amount) {
  const { error } = await supabase.from('stays')
    .update({ overstay_fee: amount }).eq('id', stayId)
  if (error) throw error
}

// Reception's "Today" — the closest real parallel to a bar's daily
// sales list is money actually collected at the desk, not items sold
// (Reception has no sales rows at all, by design: check-in/checkout/
// payment are all stays/payments, never sales). Joins to the guest
// and room for display, same way the folio itself shows a payment.
export async function loadReceptionActivity(branchId, date) {
  const { data, error } = await supabase.from('payments')
    .select(`id, method, amount, is_overstay, remark, created_at, received_by,
             staff:received_by(full_name),
             stays(id, rooms(room_number), guests!guest_id(full_name))`)
    .eq('branch_id', branchId).eq('business_date', date)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Deletes an entire training booking — stay, its orders/order_items,
// and its payments, in one RPC. Already enforces GM/Admin at the
// database level (is_supervisor()), confirmed against its real body
// rather than assumed; the app-side role check below is just for
// showing the right UI, not the actual security.
export async function deleteStay(stayId) {
  const { error } = await supabase.rpc('delete_stay', { target: stayId })
  if (error) throw error
}

// ---------- Settings: room rates and the branch overstay default ----------
// rooms UPDATE and branches UPDATE are both genuinely enforced at the
// database level (can_manage_rooms(), is_supervisor()) — confirmed
// directly, not assumed from the reference app's client-side checks.

export async function loadRoomsForSettings(branchId) {
  const { data, error } = await supabase.from('rooms')
    .select('id, room_number, rate_standard, rate_alternate, rate_short, is_active, room_categories(name)')
    .eq('branch_id', branchId)
  if (error) throw error
  return (data || []).sort((a, b) =>
    String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

export async function updateRoomRates(roomId, patch) {
  const { error } = await supabase.from('rooms').update(patch).eq('id', roomId)
  if (error) throw error
}

export async function updateBranchOverstayDefault(branchId, amount) {
  const { error } = await supabase.from('branches')
    .update({ overstay_fee: amount }).eq('id', branchId)
  if (error) throw error
}

// ---------- Reception's debt: guest room balances, not customer credit ----------
// A completely different schema from the customers/credit_repayments
// system every other department uses — guest debt lives in
// stays/payments, tracked per stay rather than per named customer.
// Credit and Recovery had never queried this before; these are what
// let those two screens represent it without merging two genuinely
// different data models into one query.

// v_stay_folio is a view, not a table — it has no foreign keys, so
// PostgREST's embedded-relationship syntax (stays!inner(...)) has no
// real path to follow from it. That silently broke this for every
// guest, not just one — confirmed directly, not assumed. Fixed by
// querying the view for the outstanding figures alone, then stays
// (a real table, so its own embed to rooms/guests works correctly)
// for just those stay ids, and merging client-side.
// Guests who've paid ahead of what they actually owe (a negative
// outstanding) — how much of that advance has been used up by
// charges so far, and what's genuinely still left as a credit.
// Restricted to live stays (occupied/reserved) — an old overpayment
// sitting on an already-checked-out stay isn't a current advance,
// it's historical, so it stays out of this list.
export async function loadAdvancePayments(branchId) {
  const { data: folios, error: e1 } = await supabase.from('v_stay_folio')
    .select('stay_id, total_due, total_paid, outstanding')
    .eq('branch_id', branchId).lt('outstanding', -0.009)
    .in('status', ['occupied', 'reserved'])
  if (e1) throw e1
  if (!folios?.length) return []

  const { data: stays, error: e2 } = await supabase.from('stays')
    .select('id, rooms(room_number), guests!guest_id(full_name)')
    .in('id', folios.map(f => f.stay_id))
  if (e2) throw e2
  const stayById = Object.fromEntries((stays || []).map(s => [s.id, s]))

  return folios.map(f => ({
    stay_id: f.stay_id,
    room_number: stayById[f.stay_id]?.rooms?.room_number,
    guest_name: stayById[f.stay_id]?.guests?.full_name,
    paid: Number(f.total_paid), usedUp: Number(f.total_due), balance: Math.abs(Number(f.outstanding)),
  }))
}

// Reception's own daily-close dashboard — POS/cash collected today,
// plus the full deferred (outstanding) and advance pictures. Kept as
// one call so the page loads it in one round trip rather than piecing
// it together from three separate fetches inline.
export async function loadReceptionDashboard(branchId, date) {
  const { data: todayPayments, error: e1 } = await supabase.from('payments')
    .select('method, amount').eq('branch_id', branchId).eq('business_date', date)
  if (e1) throw e1
  const pos = (todayPayments || []).filter(p => p.method === 'pos').reduce((s, p) => s + Number(p.amount), 0)
  const cash = (todayPayments || []).filter(p => p.method === 'cash').reduce((s, p) => s + Number(p.amount), 0)

  const [deferred, advances] = await Promise.all([
    loadGuestBalances(branchId),
    loadAdvancePayments(branchId),
  ])
  const deferredTotal = deferred.reduce((s, g) => s + g.outstanding + g.departmentCredit + g.billedToYou, 0)
  const advanceTotal = advances.reduce((s, a) => s + a.balance, 0)

  return { pos, cash, deferred, deferredTotal, advances, advanceTotal }
}

export async function loadGuestBalances(branchId, staffId) {
  const { data: folios, error: e1 } = await supabase.from('v_stay_folio')
    .select('stay_id, billing_cycle, outstanding')
    .eq('branch_id', branchId).gt('outstanding', 0.009)
  if (e1) throw e1

  const stayIds = (folios || []).map(f => f.stay_id)
  const { data: stays, error: e2 } = stayIds.length
    ? await supabase.from('stays')
        .select('id, guest_id, bill_to, created_by, rooms(room_number), guests!guest_id(full_name)')
        .in('id', stayIds)
    : { data: [] }
  if (e2) throw e2
  const stayById = Object.fromEntries((stays || []).map(s => [s.id, s]))
  const coveredGuestIds = new Set((stays || []).map(s => s.guest_id).filter(Boolean))

  // Every guest at this branch with linked department credit — not
  // just the ones already picked up above with an outstanding room
  // balance. Filters on branch_id directly (a plain column on the
  // view) rather than embedding guests from it, which PostgREST
  // can't reliably do from a view (no foreign key to follow).
  const { data: deptRows } = await supabase.from('v_guest_department_credit')
    .select('guest_id, balance').eq('branch_id', branchId)
  const deptTotalByGuest = {}
  for (const d of deptRows || []) {
    deptTotalByGuest[d.guest_id] = (deptTotalByGuest[d.guest_id] || 0) + Number(d.balance)
  }

  // Other stays whose bill_to_guest_id points at a guest — the
  // structured half of Bill To. Same reasoning as department credit:
  // this list is where staff actually look for who owes what, so it
  // needs the full picture, not just what shows on a folio someone
  // has to think to open.
  const { data: billToStays } = await supabase.from('stays')
    .select('id, bill_to_guest_id').eq('branch_id', branchId).not('bill_to_guest_id', 'is', null)
  const billToTotalByGuest = {}
  if (billToStays?.length) {
    const { data: billToFolios } = await supabase.from('v_stay_folio')
      .select('stay_id, outstanding').in('stay_id', billToStays.map(s => s.id)).gt('outstanding', 0.009)
    const folioByStay = Object.fromEntries((billToFolios || []).map(f => [f.stay_id, f]))
    for (const s of billToStays) {
      const f = folioByStay[s.id]
      if (!f) continue
      billToTotalByGuest[s.bill_to_guest_id] = (billToTotalByGuest[s.bill_to_guest_id] || 0) + Number(f.outstanding)
    }
  }

  const rows = folios.map(f => ({
    stay_id: f.stay_id, billing_cycle: f.billing_cycle, outstanding: Number(f.outstanding),
    room_number: stayById[f.stay_id]?.rooms?.room_number,
    guest_name: stayById[f.stay_id]?.guests?.full_name,
    bill_to: stayById[f.stay_id]?.bill_to,
    created_by: stayById[f.stay_id]?.created_by,
    departmentCredit: deptTotalByGuest[stayById[f.stay_id]?.guest_id] || 0,
    billedToYou: billToTotalByGuest[stayById[f.stay_id]?.guest_id] || 0,
  }))

  // A guest whose own room is fully paid but who still owes via
  // department credit or someone else's bill shouldn't silently
  // disappear from this list — find their most recent stay just for
  // display (room number, name).
  const extraGuestIds = [...new Set([...Object.keys(deptTotalByGuest), ...Object.keys(billToTotalByGuest)])]
    .filter(gid => !coveredGuestIds.has(gid))
  if (extraGuestIds.length) {
    const { data: extraStays } = await supabase.from('stays')
      .select('id, guest_id, bill_to, created_by, created_at, rooms(room_number), guests!guest_id(full_name)')
      .in('guest_id', extraGuestIds).order('created_at', { ascending: false })
    const seen = new Set()
    for (const s of extraStays || []) {
      if (seen.has(s.guest_id)) continue   // only the most recent stay per guest
      seen.add(s.guest_id)
      rows.push({
        stay_id: s.id, billing_cycle: null, outstanding: 0,
        room_number: s.rooms?.room_number, guest_name: s.guests?.full_name,
        bill_to: s.bill_to, created_by: s.created_by,
        departmentCredit: deptTotalByGuest[s.guest_id] || 0,
        billedToYou: billToTotalByGuest[s.guest_id] || 0,
      })
    }
  }

  // Total (room + department + other bills) decides both what's
  // shown and the sort order, per explicit correction — a guest
  // owing heavily elsewhere shouldn't rank behind one who owes a
  // small room balance just because the room figure alone used to be
  // the sort key.
  return rows
    .filter(r => !staffId || r.created_by === staffId)
    .sort((a, b) => (b.outstanding + b.departmentCredit + b.billedToYou) - (a.outstanding + a.departmentCredit + a.billedToYou))
}

// Recent room payments across the branch — Recovery's Reception view,
// same idea as its customer-repayment history but sourced from
// payments/stays instead of credit_repayments/customers.
export async function loadRoomPayments(branchId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('payments')
    .select(`id, business_date, method, amount, is_overstay, remark, received_by,
             staff:received_by(full_name),
             stays(rooms(room_number), guests!guest_id(full_name))`)
    .eq('branch_id', branchId).gte('business_date', since)
    .order('business_date', { ascending: false })
  if (error) throw error
  return data || []
}

// GM/admin cleanup for a practice payment — a single, self-contained
// delete. Unlike deleting a whole training booking (delete_stay),
// this never touches the stay itself: if training happened against a
// real, live room, the room's actual booking and every other real
// charge/payment on it are completely untouched — only the one
// erroneous payment row goes.
export async function deleteRoomPayment(paymentId) {
  const { error } = await supabase.from('payments').delete().eq('id', paymentId)
  if (error) throw error
}

// ---------- Editing/deleting a room-charge order line ----------
// No new stock logic needed — sync_order_item_stock_movement (built
// when room charges were first added) already handles update/delete
// symmetrically, adjusting or removing the associated stock movement
// on its own. Delete also cleans up the parent order if this was its
// only line, so a single-item order doesn't leave an empty orphan
// behind — every order/order_item pair here is 1:1, matching how the
// front-desk app itself always created them.

export async function updateOrderItem(orderItemId, patch) {
  const { error } = await supabase.from('order_items').update(patch).eq('id', orderItemId)
  if (error) throw error
}

export async function deleteOrderItem(orderItemId, orderId) {
  const { error: e1 } = await supabase.from('order_items').delete().eq('id', orderItemId)
  if (e1) throw e1
  const { data: remaining, error: e2 } = await supabase.from('order_items')
    .select('id').eq('order_id', orderId).limit(1)
  if (e2) throw e2
  if (!remaining?.length) {
    const { error: e3 } = await supabase.from('orders').delete().eq('id', orderId)
    if (e3) throw e3
  }
}

// Restaurant food charged to a room lives in orders/order_items, not
// sales — a room-charged order was never shown on Restaurant's own
// Today list at all, since that list only ever queried sales. Joins
// through to the guest/room for display, same context the folio
// itself shows.
// Room-charged items belonging to one department's category — food
// (Restaurant), minimart (Minimart), or drink (bar departments).
// location_id is only ever set on catalog-item charges, never on
// typed ones, so category is the one field that reliably identifies
// which department a room charge belongs to.
export async function loadRoomCharges(branchId, date, category) {
  const { data, error } = await supabase.from('order_items')
    .select(`id, description, qty, unit_price, amount, order_id, order_type, damage_reason, writeoff_note, pr_meal,
             orders!inner(id, business_date, branch_id, served_by, created_at,
                          stays(rooms(room_number), guests!guest_id(full_name)))`)
    .eq('category', category).eq('orders.branch_id', branchId).eq('orders.business_date', date)
  if (error) throw error
  return data || []
}

// Backward-compatible alias — Restaurant's own category.
export async function loadRestaurantRoomCharges(branchId, date) {
  return loadRoomCharges(branchId, date, 'food')
}

// ---------- Restaurant order type: PR/Damage and Staff write-offs ----------
// Standard orders are unchanged — they go through the normal basket/
// payment flow. PR/Damage and Staff never collect payment at all, so
// they're a direct save, the same way the existing catalog PR/Damage
// write-off (saveWriteoff) bypasses the sales basket entirely rather
// than trying to thread "no payment required" through it.

export async function saveRestaurantWriteoff({ staff, locationId, businessDate,
                                                description, qty, unitPrice,
                                                orderType, damageReason, writeoffNote, prMeal }) {
  const { error } = await supabase.from('sales').insert({
    branch_id: staff.branch_id, business_date: businessDate, occurred_at: new Date().toISOString(),
    stock_item_id: null, description, location_id: locationId, tier: 'general',
    qty, unit_price: unitPrice, recorded_by: staff.id,
    order_type: orderType, damage_reason: damageReason || null, writeoff_note: writeoffNote || null,
    pr_meal: prMeal || null,
  })
  if (error) throw error
}

export async function chargeWriteoffToRoom({ staff, stayId, businessDate,
                                              description, qty, unitPrice,
                                              orderType, damageReason, writeoffNote, prMeal }) {
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    settlement: 'charged_to_room', served_by: staff.id,
  }).select('id').single()
  if (oErr) throw oErr
  const { error: iErr } = await supabase.from('order_items').insert({
    order_id: order.id, category: 'food', stock_item_id: null, location_id: null,
    description, qty, unit_price: unitPrice,
    order_type: orderType, damage_reason: damageReason || null, writeoff_note: writeoffNote || null,
    pr_meal: prMeal || null,
  })
  if (iErr) {
    await supabase.from('orders').delete().eq('id', order.id)
    throw iErr
  }
}

// Out-of-service toggle for maintenance — the RPC itself already
// enforces can_manage_rooms() and refuses to take an occupied room
// out of service (naming the guest), confirmed against its real body
// rather than assumed. This just calls it.
export async function setRoomServiceStatus(roomId, outOfService, reason) {
  const { error } = await supabase.rpc('set_room_service_status', {
    target: roomId, out_of_svc: outOfService, reason: reason || null,
  })
  if (error) throw error
}
