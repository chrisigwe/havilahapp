import { supabase } from './supabase'
import { lagosDaysAgo, lagosToday, addDays, chargeCategoryFor, nameKey } from './format'
import { normalizeCustomerName } from './customerName'
import { nightsInWindow } from './nights'
import { SUPERVISOR } from './roles'
import { tracked } from './activity'

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
  const seesAllBranches = SUPERVISOR.includes(staff.role)
  const b = (seesAllBranches && viewBranchId) ? viewBranchId : staff.branch_id
  const [locs, tiers, methods, items, assigned, branchRow] = await Promise.all([
    supabase.from('stock_locations').select('*').eq('branch_id', b).order('sort_order'),
    supabase.from('branch_price_tiers').select('tier').eq('branch_id', b),
    supabase.from('branch_payment_methods').select('method').eq('branch_id', b),
    supabase.from('stock_items').select('*').eq('branch_id', b).eq('is_active', true).order('name'),
    supabase.from('staff_locations').select('location_id').eq('staff_id', staff.id),
    supabase.from('branches').select('name, slug, room_charge_approval_limit').eq('id', b).maybeSingle(),
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
  let validDefault = visible.some(l => l.id === staff.default_location_id)
    ? staff.default_location_id : null
  // Viewing ANOTHER branch (only GM/admin can): the stored default belongs
  // to the home branch, so use the department with the same name here. A
  // GM whose default is Awka's Reception opens on Nnewi's Reception, not
  // on whichever department happens to come first. One small query, and
  // only in that case; everyone else's default is always in their branch.
  if (!validDefault && staff.default_location_id) {
    const { data: home } = await supabase.from('stock_locations')
      .select('name').eq('id', staff.default_location_id).maybeSingle()
    const twin = home && visible.find(l => l.name === home.name)
    if (twin) validDefault = twin.id
  }
  if (!validDefault) {
    validDefault = visible.find(l => l.is_sales_point && !l.is_store)?.id || visible[0]?.id || null
  }

  return {
    // pages read staff.branch_id everywhere, so point it at the branch
    // being viewed; realBranchId keeps the person's home branch
    staff: { ...staff, branch_id: b, realBranchId: staff.branch_id,
             default_location_id: validDefault },
    seesAllBranches,
    branchName: branchRow?.data?.name || '',
    // null = room-charge approvals are off for this branch (migration
    // 270). Drives whether the approval screens mount at all, so they
    // are not polling every 15s for something that cannot happen — and
    // setting a number brings the whole feature back with no code change.
    roomChargeApprovalLimit: branchRow?.data?.room_charge_approval_limit ?? null,
    viewBranchId: b,
    seesAll,
    allLocations: locs.data,
    locations: visible,
    tiers: tiers.data.map(t => t.tier),
    methods: methods.data.map(m => m.method),
    // supplies (used up, not sold) are kept apart from sale stock: they are
    // received into the Store and issued out as "supplies used"
    items: items.data.filter(i => !i.is_consumable),
    supplyItems: items.data.filter(i => i.is_consumable),
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
  const cols = `id, stock_item_id, description, location_id, tier, qty, unit_price, amount, created_at,
             receipt_id, business_date, recorded_by, on_behalf_of, order_type, damage_reason, writeoff_note, pr_meal,
             no_stock_declared,
             recorder:recorded_by(full_name), stood_in_for:on_behalf_of(full_name),
             sale_payments(method, amount)`
  const run = (extra) => {
    let q = supabase.from('sales').select(cols + extra)
      .eq('branch_id', branchId).eq('business_date', date)
    if (locationId) q = q.eq('location_id', locationId)
    return q.order('created_at', { ascending: false })
  }
  // "Stock used" rows ride along when the database has them (migration 340b);
  // if it does not yet, the list must still load exactly as before.
  const first = await run(', order_stock_used(qty, stock_items(name))')
  if (!first.error) return first.data
  const { data, error } = await run('')
  if (error) throw error
  return data
}

// Records a basket: one sales row per line, with the basket's payment
// split allocated across those lines in order.
async function _saveBasket({ staff, locationId, lines, payments, date, customerId, backdateReason, receiptId, onBehalfOf }) {
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
    // Stock used with this order (water, extra chicken ...): comes off the
    // department's stock and is tied to the order — migration 340b. Done
    // last so a failure here can never leave a half-saved sale; if it does
    // fail, say clearly that the order itself WAS saved.
    if (line.stockUsed?.length) {
      try { await recordStockUsed(sale.id, line.stockUsed) }
      catch (e) {
        throw partialStockError(e)
      }
    }
  }
  return receipt
}

export async function recordOrderItemStockUsed(orderItemId, used) {
  const { error } = await supabase.rpc('record_order_item_stock_used', {
    p_item: orderItemId,
    p_lines: used.map(u => ({ item: u.item.id, qty: Number(u.qty) })),
  })
  if (error) throw error
}

// The order WAS saved; only the stock-used part failed — say so plainly so
// nobody enters the charge twice.
const partialStockError = (e) => Object.assign(new Error(
  `The order WAS saved, but the stock used was not recorded (${e.message}). Do not enter it again — tell your manager.`),
  { partial: true })

export async function recordStockUsed(saleId, used) {
  const { error } = await supabase.rpc('record_stock_used', {
    p_sale: saleId,
    p_lines: used.map(u => ({ item: u.item.id, qty: Number(u.qty) })),
  })
  if (error) throw error
}

async function _saveWriteoff({ staff, item, locationId, kind, qty, unitValue, note, date, damageReason }) {
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
  // own-only matches app_owns_recent7() in the database exactly: today
  // and the six days before, by Lagos calendar date (migration 389)
  const since = ownOnlyStaffId ? lagosDaysAgo(6) : lagosDaysAgo(days)
  const own = (q) => ownOnlyStaffId ? q.eq('recorded_by', ownOnlyStaffId) : q
  // a movement's "location" is from_location OR to_location, same
  // convention rowLocationId already uses for display — filtering by
  // department has to match either side, not one fixed column
  const atLocation = (q, col) => locationId
    ? (col === 'sale' ? q.eq('location_id', locationId)
                       : q.or(`from_location.eq.${locationId},to_location.eq.${locationId}`))
    : q
  // Who recorded it, by name. A corrections list that cannot say whose
  // entry this is makes every judgement about it guesswork, and the
  // page already decides what you may do by comparing recorded_by to
  // your own id — it just never showed it (18 October 2026). Both joins
  // are the ones loadToday and the Store screen already use, so they
  // resolve over the same foreign keys and the same policies.
  // stock_items(name): the name comes from the ROW, not from a list held
  // in the browser (Chris, 25 October 2026 — "the store shows unknown
  // items").
  //
  // The screen used to look every name up in boot.items, which is the
  // SALE items: loadBranchData splits the catalogue in two and keeps
  // supplies in boot.supplyItems. So every supply the storekeeper
  // disbursed came back "Unknown item" — three of them to the Restaurant
  // on 24 October alone. It reads like lost data and is only a lookup in
  // the wrong list.
  //
  // Fixing the list alone would leave the other half: boot also drops
  // is_active = false, so retiring an item would blank its whole history
  // here. Reading the name off the row covers both, and cannot drift
  // from however the catalogue is split in future.
  const saleCols = 'id, business_date, stock_item_id, description, location_id, tier, qty, unit_price, amount,'
    + ' recorded_by, on_behalf_of, created_at, customers(name), stock_items(name),'
    + ' recorder:recorded_by(full_name), stood_in_for:on_behalf_of(full_name)'
  const moveCols = 'id, business_date, stock_item_id, movement_type, from_location, to_location, qty,'
    + ' unit_cost, note, damage_reason, recorded_by, created_at, stock_items(name), staff:recorded_by(full_name)'
  const [sales, moves] = await Promise.all([
    // a sale recorded on someone's behalf belongs on THEIR list, not
    // the recorder's, so match either column
    atLocation(
      (ownOnlyStaffId
        ? supabase.from('sales')
            .select(saleCols)
            .eq('branch_id', branchId).gte('business_date', since)
            .or(`recorded_by.eq.${ownOnlyStaffId},on_behalf_of.eq.${ownOnlyStaffId}`)
        : supabase.from('sales')
            .select(saleCols)
            .eq('branch_id', branchId).gte('business_date', since)
      ), 'sale'
    ).order('created_at', { ascending: false }).limit(300),
    atLocation(own(supabase.from('stock_movements')
      .select(moveCols)
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

async function _deleteEntry(entry) {
  if (entry.kind === 'sale') {
    // One database step, GM/admin only: payments and sale are removed
    // together or not at all. Two client calls (payments, then sale)
    // could strip a sale's payments and then fail on the sale itself,
    // leaving a sale with no payment — silently gone from the cash-up.
    const { error } = await supabase.rpc('delete_sale', { p_sale: entry.id })
    if (error) throw error
  } else {
    const { error } = await supabase.from('stock_movements').delete().eq('id', entry.id)
    if (error) throw error
  }
}

// Putting a movement in the right department (571).
//
// updateEntry changes the quantity and the cost and nothing else, so
// stock keyed into the wrong place could only be deleted and re-entered
// — losing who recorded it and when. Reception sat at −5 "A Plate of
// Groundnut" because a conversion on 18 October was recorded there
// instead of where the groundnut actually is.
//
// A function rather than a column update: a movement created BY a sale
// must not be moved (the goods would end up somewhere the sale never
// happened), both ends must be at the same branch, and stock cannot come
// from and go to the same place. log_movement_change writes the before
// and after once 571 is in.
export async function correctMovementPlace(movementId, { from, to, date } = {}) {
  const { data, error } = await supabase.rpc('correct_movement_place', {
    p_movement: movementId,
    p_from: from === undefined ? null : from,
    p_to: to === undefined ? null : to,
    p_date: date || null,
  })
  if (error) throw error
  return data
}

export async function updateEntry(entry, { qty, unitPrice }) {
  // Stock movements only. The sale branch that used to be here collapsed
  // every payment into ONE row of the first method found (or 'cash') — so
  // correcting the quantity on a part-cash, part-credit sale would have
  // erased the credit, and the customer's debt with it. Nothing called it
  // for sales (Corrections uses updateSaleWithPayments), and direct sale
  // edits are now refused by the database (257) — so it is removed rather
  // than left as a trap.
  if (entry.kind === 'sale') {
    throw new Error('Sales are edited with updateSaleWithPayments, which keeps the payment split.')
  }
  const patch = { qty }
  if (unitPrice !== undefined && unitPrice !== null && unitPrice !== '') patch.unit_cost = unitPrice
  const { error } = await supabase.from('stock_movements').update(patch).eq('id', entry.id)
  if (error) throw error
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
// Money a guest paid AT a department (e.g. "charge to a room" settled at
// MainBar) is that department's money: it collects a debt the department
// raised when it charged the room. Reception's own payments are excluded;
// they have their own dashboard. One department when locationId is given,
// every non-Reception department otherwise.
export async function loadGuestCollections(branchId, date, locationId = null) {
  let q = supabase.from('payments')
    .select(`id, method, amount, location_id, created_at,
             collected:stock_locations!location_id(name),
             staff:received_by(full_name),
             stays(rooms(room_number), guests!guest_id(full_name))`)
    .eq('branch_id', branchId).eq('business_date', date)
    .not('location_id', 'is', null)
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).filter(p => !/reception|front/i.test(p.collected?.name || ''))
}

export async function loadDailyFinancials(branchId, date, locationId) {
  const { data, error } = await supabase.rpc('get_daily_financials', {
    p_branch: branchId, p_date: date, p_location: locationId || null,
  })
  if (error) throw error
  return {
    byMethod: data.byMethod || {},
    nonRevenue: data.nonRevenue || [],
    // Debt settled WITHOUT money changing hands: deducted from wages
    // (276) or written off (296). Both are excluded from debtRecovered
    // and totalMoneyIn, so they must be shown separately or a large
    // settlement happens with nothing on screen to say so.
    debtClearedByPayroll: Number(data.debtClearedByPayroll || 0),
    debtWrittenOff: Number(data.debtWrittenOff || 0),
    grossSales: Number(data.grossSales || 0),
    received: Number(data.received || 0),
    creditRaised: Number(data.creditRaised || 0),
    unqualifiedCredit: Number(data.unqualifiedCredit || 0),
    // Debt recovered now covers BOTH kinds, because they are the same
    // thing (531): a customer paying off an account, and a guest paying
    // off what a department let them charge to their room. Kept split
    // underneath so the day can still say which was which.
    //
    // recoveredBy carries both, and it is what the POS/Cash figures are
    // built from — the app must NOT add room-bill money on top of it
    // any more, or the same naira is counted twice.
    debtRecovered: Number(data.debtRecovered || 0),
    recoveredBy: data.recoveredBy || {},
    recoveredFromCustomers: Number(data.recoveredFromCustomers || 0),
    recoveredFromRooms: Number(data.recoveredFromRooms || 0),
    customerRecoveredBy: data.customerRecoveredBy || {},
    roomRecoveredBy: data.roomRecoveredBy || {},
    roomChargedCountedAsSales: Number(data.roomChargedCountedAsSales || 0),
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

// Who served each line on a customer's statement (Chris, 25 October
// 2026). A customer querying a line asks "who gave me this?", and until
// now the invoice could not say — the name was on the record all along,
// just never printed.
//
// on_behalf_of first, then recorded_by: a sale keyed by the storekeeper
// on behalf of the barman was SERVED by the barman. That is the same
// precedence credit_chain uses (570), so the statement and the chain
// name the same person.
//
// The names are fetched in one separate lookup rather than embedded in
// the select. on_behalf_of is a second staff column on the same table
// and an embed needs a foreign key PostgREST can see; guessing one is
// exactly what broke the Recently-added feed on both branches on
// 24 October. A plain lookup by id cannot fail that way.
export async function loadCustomerLedger(branchId, customerId, locationId, staffId) {
  let sq = supabase.from('sales')
    .select('id, business_date, qty, unit_price, stock_item_id, description, location_id, tier, recorded_by, on_behalf_of, sale_payments(method, amount)')
    .eq('branch_id', branchId).eq('customer_id', customerId)
  let rq = supabase.from('credit_repayments')
    .select('id, paid_on, method, amount, note, location_id, credit_staff_id, recorded_by')
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

  // One lookup for every name on the statement, both tables at once.
  const ids = [...new Set([
    ...credit.flatMap(r => [r.on_behalf_of, r.recorded_by]),
    ...repays.data.flatMap(r => [r.credit_staff_id, r.recorded_by]),
  ].filter(Boolean))]
  let names = {}
  if (ids.length) {
    const { data: who } = await supabase.from('staff').select('id, full_name').in('id', ids)
    for (const w of (who || [])) names[w.id] = w.full_name
  }
  // A missing name is left empty, never guessed at. A statement that
  // prints the wrong server is worse than one that prints none.
  const nameOf = (...maybe) => {
    for (const id of maybe) if (id && names[id]) return names[id]
    return ''
  }
  return {
    credit: credit.map(r => ({ ...r, served_by: nameOf(r.on_behalf_of, r.recorded_by) })),
    repayments: repays.data.map(r => ({ ...r, taken_by: nameOf(r.credit_staff_id, r.recorded_by) })),
  }
}

async function _saveRepayment({ staff, customerId, amount, method, paidOn, note, locationId, creditStaffId }) {
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
    .select('stock_item_id, system_qty, counted_qty, auditor_adjusted, adjusted_by, variance_reason')
    .eq('count_id', countId)
  if (error) throw error
  return data
}

export async function saveCountLine(countId, itemId, qty) {
  const { error } = await supabase.from('stock_count_lines')
    .update({ counted_qty: qty }).eq('count_id', countId).eq('stock_item_id', itemId)
  if (error) throw error
}

// Why this line differs from the book (migration 545). Carried onto the
// stock movement when the count posts, so the item's history says why
// the figure moved and not merely that it did. verify_stock_count and
// post_opening_balance both refuse to post without it — this is the
// pleasant way to supply it, not the rule itself.
export async function saveCountReason(countId, itemId, reason) {
  const { error } = await supabase.from('stock_count_lines')
    .update({ variance_reason: reason || null })
    .eq('count_id', countId).eq('stock_item_id', itemId)
  if (error) throw error
}

async function _submitCount(countId) {
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

async function _verifyCount(countId) {
  const { error } = await supabase.rpc('verify_stock_count', { p_count: countId })
  if (error) throw error
}

async function _deleteCount(countId) {
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

// Edit a sale's quantity, price and payment split in ONE database step.
// Previously three client calls — update the sale, delete its payments,
// re-add them — which meant everyone who could edit also held the right
// to delete payment rows directly, and a failure between the calls could
// leave a sale with no payment. edit_sale() (migration 257) does it
// atomically and applies the same who-may-edit rule itself.
export async function updateSaleWithPayments(saleId, { qty, unitPrice, payments, businessDate }) {
  const { error } = await supabase.rpc('edit_sale', {
    p_sale: saleId, p_qty: qty, p_unit_price: unitPrice,
    p_payments: payments.map(p => ({ method: p.method, amount: Number(p.amount) || 0 })),
    // null = leave the date as it is. The database refuses a date change
    // from anyone not allowed to make one, and the usual date rules
    // (no future dates, nothing before opening, backdate window) apply.
    p_business_date: businessDate || null,
  })
  if (error) throw error
}

export async function loadRecovery(branchId, locationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  // Write-offs are not recoveries: nothing was collected, the debt was
  // forgiven. Including them would show N250,100 "recovered" on the day
  // it was written off. Payroll deductions DO stay — that money is
  // genuinely recovered, just from wages rather than a till.
  let q = supabase.from('v_debt_recovery')
    .select('id, paid_on, method, amount, note, customer_name, location_name, recovered_by_name, credit_staff_name, location_id, first_credit_date, last_credit_date')
    .eq('branch_id', branchId).gte('paid_on', since)
    .neq('method', 'writeoff')
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
async function _deleteRepayment(id) {
  const { error } = await supabase.from('credit_repayments').delete().eq('id', id)
  if (error) throw error
}

async function _saveMovements(rows) {
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
    .filter(s => !locationId || !(s.staff_locations || []).length
                 || (s.staff_locations || []).some(l => l.location_id === locationId))
    .map(({ staff_locations, ...s }) => s)
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

// Everything that has ARRIVED anywhere, newest first (Chris, 24 October
// 2026). The Stock page could say what is on a shelf but never how it
// got there — so stock added to the wrong department looked exactly like
// stock that had always been there, and the only clue was a figure going
// below zero somewhere else.
//
// Every movement with a to_location: supplies received into the store,
// transfers and issues out to departments, and the incoming half of a
// conversion. from_location says where it came from, which is what makes
// a wrong department obvious at a glance.
export async function loadRecentlyAdded(branchId, locationId = null, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  let q = supabase.from('stock_movements')
    // received_by is the receiver's NAME, typed into the box on the Store
    // page — not a link to a staff row. Asking PostgREST to join it broke
    // the whole feed on both branches (25 October 2026). recorded_by IS a
    // staff id, and keeps its join.
    .select(`id, business_date, created_at, qty, movement_type, note,
             from_location, to_location, received_by,
             stock_items(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId)
    .not('to_location', 'is', null)
    .gte('business_date', since)
  if (locationId) q = q.eq('to_location', locationId)
  const { data, error } = await q
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) throw error
  return data || []
}

// what a department has received from the store — transfers and
// issues, newest first. Used on the Store screen's history section.
export async function loadDepartmentHistory(branchId, locationId, days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`business_date, qty, received_by, movement_type, created_at, note, stock_item_id,
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
    // note carries the pack arithmetic a receive was keyed with — "5
    // crates × 12" — so the history can show what was actually carried
    // in, not only the 60 it became (575).
    .select(`business_date, qty, received_by, created_at, note, stock_item_id,
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
    .select(`business_date, qty, received_by, created_at, from_location, to_location, note, stock_item_id,
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
    .select(`business_date, qty, note, created_at, stock_item_id,
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
export async function auditorAdjustCountLine(countId, itemId, qty, reason) {
  const { error } = await supabase.rpc('auditor_adjust_count_line', {
    p_count: countId, p_item: itemId, p_qty: qty, p_reason: reason,
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
// Every room charge must name a department that actually sells something.
//
// Reception sells nothing of its own — it charges on another department's
// behalf — so a line attributed to Reception belongs to nobody: it shows
// on no department's list and the department that provided the goods never
// sees it. Before migration 503 such a line saved with no department at
// all and fell back to Restaurant by category, which was right by luck for
// food and wrong for anything else.
//
// Refusing here rather than at one screen means every path is covered: the
// room-charge sheet, a single charge, and a basket.
const assertSellingDept = (locationName) => {
  if (!locationName) {
    throw new Error('This charge has no department. Pick the department whose goods these are.')
  }
  if (/reception/i.test(locationName)) {
    throw new Error('Reception cannot be the department on a room charge — '
      + 'it sells nothing of its own. Choose the department the goods came from '
      + '(Restaurant, MainBar, Minimart and so on).')
  }
}

async function _chargeItemToRoom({ staff, stayId, item, locationId, locationName,
                                          description, qty, unitPrice, businessDate,
                                          orderType, writeoffNote, stockUsed }) {
  assertSellingDept(locationName)
  // Category follows the DEPARTMENT, for a typed line as much as a
  // catalogue one. It used to be hardcoded 'food' on anything typed,
  // which filed a typed bar charge as Restaurant food.
  const category = chargeCategoryFor(locationName)
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    settlement: 'charged_to_room', served_by: staff.id,
  }).select('id').single()
  if (oErr) throw oErr
  const { data: oi, error: iErr } = await supabase.from('order_items').insert({
    order_id: order.id, category,
    stock_item_id: item?.id || null,
    // The department this charge came from, recorded on a TYPED line too.
    // It used to be left null on those to keep the stock trigger quiet,
    // but sync_order_item_stock_movement returns early when
    // `stock_item_id is null OR location_id is null` — the stock_item_id
    // half already stops it, confirmed against the live trigger body.
    // So a typed line can say where it came from and still move no stock,
    // which is what lets the restaurant's bill be settled on its own.
    location_id: locationId || null,
    description: item ? item.name : description, qty, unit_price: unitPrice,
    order_type: orderType === 'staff' ? 'staff' : 'standard', writeoff_note: writeoffNote || null,
  }).select('id').single()
  if (iErr) {
    await supabase.from('orders').delete().eq('id', order.id)
    throw iErr
  }
  if (stockUsed?.length) {
    try { await recordOrderItemStockUsed(oi.id, stockUsed) } catch (e) { throw partialStockError(e) }
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

// Everything a department (or, with no location, every department of the
// branch) has charged to rooms: unpaid and part-paid lines however old, plus
// recently settled ones. See migration 337 for how a line is judged.
export async function loadDepartmentRoomCharges(branchId, locationId = null, days = 14) {
  const { data, error } = await supabase.rpc('department_room_charges', {
    p_branch: branchId, p_location: locationId || null, p_days: days,
  })
  if (error) throw error
  return data || []
}

// Money Reception collected today against a department's room charges.
//
// Goods that left MainBar on a guest's room bill are MainBar's goods, and
// when the front desk collects for them the money is MainBar's. It keeps
// the form it was paid in: a guest settling ₦30,000 on POS leaves ONE slip
// at the front desk with each department's share written on it, so that
// share is POS to the department too. Only cash actually changes hands.
// Either way it belongs in that department's Total Sales check — and if it
// is missing, that gap is the point.
//
// Only answerable since migration 505: before a payment recorded WHICH
// charges it settled, there was no way to say whose money it was.
//
// Returns one row per ticked charge with its payment method, and the
// department left for the caller to resolve through roomChargeDept — the
// same rule the day's list and the tracker use, stated once.
export async function loadRoomBillHandover(branchId, date) {
  const { data, error } = await supabase.from('payment_items')
    .select(`amount,
             order_items!inner(location_id, category, description),
             payments!inner(business_date, branch_id, method, location_id,
                            stays(rooms(room_number), guests!guest_id(full_name)))`)
    .eq('payments.branch_id', branchId)
    .eq('payments.business_date', date)
    // Money only. A write-off clears a debt without anyone paying, and a
    // payroll deduction never reaches a till either — counting those as
    // handover put ₦54,000 of written-off Restaurant food on the
    // Restaurant's POS figure on 14 October and took it off Reception's.
    .in('payments.method', ['pos', 'cash'])
  if (error) return []
  return (data || []).map(r => ({
    amount: Number(r.amount || 0),
    // How the guest paid decides WHERE the department's share shows up.
    // POS money is in the bank and the departments' shares are written on
    // the one physical slip; cash actually changes hands at close.
    method: r.payments?.method || null,
    // WHERE the money was taken. Null is the front desk; anything else
    // is a department's own till. Reception may only be debited for
    // shares that actually passed through Reception — see SalesEntry.
    paymentLocationId: r.payments?.location_id || null,
    location_id: r.order_items?.location_id || null,
    category: r.order_items?.category || null,
    // Only the GM's Daily sales page reads these three; the department
    // card needs the amount and the method and nothing else.
    charge: r.order_items?.description || null,
    room: r.payments?.stays?.rooms?.room_number || null,
    guest: r.payments?.stays?.guests?.full_name || null,
  }))
}

// Stock used with restaurant orders on one day (migration 340b/341), for the
// daily report: every item taken from stock, and the order it was used with.
export async function loadStockUsedOnDay(branchId, date, locationId = null) {
  let q = supabase.from('order_stock_used')
    .select(`id, qty, location_id, stock_items(name),
             sales(description, order_type, writeoff_note, recorder:recorded_by(full_name)),
             order_items(description, order_type, orders(served:served_by(full_name), stays(rooms(room_number))))`)
    .eq('branch_id', branchId).eq('business_date', date).order('created_at', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Reservations not yet arrived (status 'reserved'), soonest first, with the
// room and guest — so front desk can see them BEFORE selling the room.
// Includes ones already due (check_in_date <= today) that nobody has
// checked in yet. `days` limits how far ahead; omit for all.
export async function loadUpcomingReservations(branchId, days = null) {
  let q = supabase.from('stays')
    .select(`id, room_id, check_in_date, scheduled_out,
             rooms(room_number, is_internal), guests!guest_id(full_name, phone)`)
    .eq('branch_id', branchId).eq('status', 'reserved')
    .order('check_in_date', { ascending: true })
  if (days != null) q = q.lte('check_in_date', addDays(lagosToday(), days))
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter(s => !s.rooms?.is_internal)
    .map(s => ({
      stayId: s.id, roomId: s.room_id, roomNumber: s.rooms?.room_number,
      guest: s.guests?.full_name || 'Guest', phone: s.guests?.phone || null,
      checkIn: s.check_in_date, scheduledOut: s.scheduled_out,
    }))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) ||
      String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }))
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
      .select('id, room_number, rate_standard, rate_alternate, rate_short, rate_special, out_of_service, room_categories(name)')
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
    .select('allowed_cycles, label_rate_standard, label_rate_alternate, label_rate_short, label_rate_special, overstay_fee')
    .eq('id', branchId).maybeSingle()
  if (error) throw error
  return {
    allowedCycles: data?.allowed_cycles || null,
    overstayDefault: data?.overstay_fee != null ? Number(data.overstay_fee) : null,
    // The first three always exist and fall back to a default name.
    // The fourth is different ON PURPOSE (574): a branch that has not
    // named its special rate is not offering one, so the key is absent
    // rather than present with a default. Every screen builds its rate
    // list from this object, so leaving the key out is what keeps the
    // rate off Awka's screens without a branch test anywhere in the UI.
    rateLabels: {
      standard: data?.label_rate_standard || 'Standard',
      alternate: data?.label_rate_alternate || 'Discounted',
      short: data?.label_rate_short || 'Short-time',
      ...(data?.label_rate_special ? { special: data.label_rate_special } : {}),
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
// Who is RESPONSIBLE for a checked-out stay's unpaid balance: the guest it
// is BILLED TO when one is linked, otherwise whoever stayed. The front
// desk's rule is that the warning points at the person billed — so when
// Mr Alphonso is billed for Mr Anthony's stay, it is Alphonso who is warned
// when he books, and Anthony is not.
//
// Only a LINKED guest (stays.bill_to_guest_id) can be pointed at. Where
// staff typed a name into "Bill to" without linking it, the app cannot tell
// who that is, so the occupant keeps the warning and the typed text is shown
// beside it. Linking it in the folio's Bill To editor moves the warning.
//
// Returns { guestId: { amount, notes: [...] } } for the guests asked about.
export async function loadOwedByGuests(guestIds) {
  const ids = [...new Set((guestIds || []).filter(Boolean))]
  const out = {}
  if (!ids.length) return out
  const cols = 'id, guest_id, bill_to, bill_to_guest_id, rooms(room_number), guests!guest_id(full_name)'
  const [own, billed] = await Promise.all([
    supabase.from('stays').select(cols).in('guest_id', ids).eq('status', 'checked_out'),
    supabase.from('stays').select(cols).in('bill_to_guest_id', ids).eq('status', 'checked_out'),
  ])
  const stays = new Map()
  for (const st of [...(own.data || []), ...(billed.data || [])]) stays.set(st.id, st)
  if (!stays.size) return out
  const { data: folios } = await supabase.from('v_stay_folio')
    .select('stay_id, outstanding').in('stay_id', [...stays.keys()]).gt('outstanding', 0.009)
  for (const f of (folios || [])) {
    const st = stays.get(f.stay_id)
    if (!st) continue
    const responsible = st.bill_to_guest_id || st.guest_id
    if (!ids.includes(responsible)) continue      // someone we were not asked about
    const slot = out[responsible] || (out[responsible] = { amount: 0, notes: [] })
    slot.amount += Number(f.outstanding)
    if (responsible !== st.guest_id) {
      const room = st.rooms?.room_number ? `, Room ${st.rooms.room_number}` : ''
      slot.notes.push(`billed to them for ${st.guests?.full_name || 'a guest'}${room}`)
    } else if (st.bill_to) {
      slot.notes.push(`billed to ${st.bill_to}`)  // typed text only — no guest to point at
    }
  }
  return out
}

// Saves ONLY who a stay is billed to. The full editor re-sends the rate,
// cycle and dates with it, which can fire the rate-adjustment trigger; a
// change to Bill To alone should never touch those columns.
export async function updateStayBillTo({ stayId, billTo, billToGuestId }) {
  const { error } = await supabase.from('stays')
    .update({ bill_to: billTo || null, bill_to_guest_id: billToGuestId || null })
    .eq('id', stayId)
  if (error) throw error
}

export async function searchSimilarGuests(branchId, query) {
  const q = query.trim()
  if (q.length < 3) return []
  // RETIRED records are excluded. The merge tool does not delete the
  // losing guest, it RENAMES it "[merged into Mr Onyeka] Mr Onyeka" — and
  // that name contains the survivor's, so a search for "Mr Onyeka" matched
  // every retired duplicate. They sort BEFORE the real one ("merged" <
  // "Mr"), and the old cap of 5 was filled by exactly the five retired
  // Onyeka records at Awka, so the live record never appeared.
  const { data, error } = await supabase.from('guests')
    .select('id, full_name, phone')
    .eq('branch_id', branchId).ilike('full_name', `%${q}%`)
    .not('full_name', 'ilike', '[merged into%')
    .order('full_name').limit(25)
  if (error) return []
  const rows = data || []
  const owed = await loadOwedByGuests(rows.map(r => r.id))
  for (const r of rows) {
    r.owing = owed[r.id]?.amount || 0
    r.billedTo = owed[r.id]?.notes.length ? owed[r.id].notes.join('; ') : null
  }
  // Anyone who owes comes first, then by name — ranked AFTER fetching a
  // wider pool, so a common name cannot hide the person who owes.
  rows.sort((x, y) => ((y.owing > 0) - (x.owing > 0)) || (y.owing - x.owing)
    || String(x.full_name).localeCompare(String(y.full_name)))
  return rows.slice(0, 6)
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

// Converts a linked customer's balance at this one department into a
// real room charge on their current live stay, zeroing out the
// workaround balance — the RPC itself enforces the link exists and
// the guest has a live stay, and handles a balance split across
// multiple staff-attribution rows correctly.
export async function moveWorkaroundToRoom(customerId, locationId) {
  const { error } = await supabase.rpc('move_workaround_credit_to_room', {
    p_customer_id: customerId, p_location_id: locationId,
  })
  if (error) throw error
}

export async function loadGuestDepartmentCredit(guestId) {
  if (!guestId) return []
  const { data, error } = await supabase.from('v_guest_department_credit')
    .select('location_id, location_name, balance')
    .eq('guest_id', guestId)
  if (error) return []
  const rows = data || []
  if (!rows.length) return rows

  // Which customer account holds it. The view reports a balance per
  // guest and department, but a repayment has to name a CUSTOMER, so the
  // folio cannot offer to settle this without one.
  //
  // Checked across the whole book (498): every guest with a linked
  // account has exactly one, carrying all their departments. Where that
  // is not true the account is deliberately left off — splitting a
  // payment between two accounts on a guess is how money lands on the
  // wrong one, and Credit can still settle it by hand.
  const { data: accounts } = await supabase.from('customers')
    .select('id, name').eq('linked_guest_id', guestId).eq('is_active', true)
  const only = (accounts || []).length === 1 ? accounts[0] : null
  return rows.map(r => ({ ...r, customerId: only?.id || null, customerName: only?.name || null }))
}

// Other stays whose bill_to_guest_id points at this guest — the
// structured half of Bill To (see createStay/updateStayDetails).
// Only stays with a real outstanding balance are worth surfacing;
// an already-settled one billed-to someone doesn't need chasing.
export async function loadBilledToYou(guestId) {
  if (!guestId) return []
  const { data: stays, error: e1 } = await supabase.from('stays')
    .select('id, status, check_in_date, guests!guest_id(full_name), rooms(room_number)')
    .eq('bill_to_guest_id', guestId)
  if (e1 || !stays?.length) return []

  // Every stay billed to this guest, whatever it comes to. A complimentary
  // or PR room adds up to nothing, and filtering those out by their balance
  // hid the arrangement entirely: the statement never showed that the room
  // had been put in this guest's name. The amount still drives the balance,
  // so a zero one changes no figure — it is simply on the record now.
  const { data: folios, error: e2 } = await supabase.from('v_stay_folio')
    .select('stay_id, total_due, total_paid, outstanding').in('stay_id', stays.map(s => s.id))
  if (e2) return []
  const folioByStay = Object.fromEntries((folios || []).map(f => [f.stay_id, f]))

  return stays
    .map(s => ({
      stay_id: s.id,
      guest_name: s.guests?.full_name,
      room_number: s.rooms?.room_number,
      check_in_date: s.check_in_date,
      checked_out: s.status === 'checked_out',
      total_due: Number(folioByStay[s.id]?.total_due || 0),
      total_paid: Number(folioByStay[s.id]?.total_paid || 0),
      outstanding: Number(folioByStay[s.id]?.outstanding || 0),
    }))
    .sort((a, b) => String(b.check_in_date).localeCompare(String(a.check_in_date)))
}

// How a billed-to stay reads when it is not money owing: a complimentary or
// PR room costs nothing, and a settled one has already been paid.
export function billedToLabel(b) {
  if (Number(b.outstanding) > 0.009) return null
  return Number(b.total_due) > 0.009 ? 'settled' : 'no charge'
}

// What a guest owes from a PAST stay, if anything — looked up while
// typing, BEFORE any stay is created, so front desk sees it while there
// is still time to settle it or decide to carry it forward.
//
// READ-ONLY, deliberately separate from findOrCreateGuest: that function
// CREATES a guest record on no match, which typing a new person's phone
// number into this box would have triggered on every keystroke, for
// people who might never actually check in.
//
// A guest cannot be "paused" across a resale of their room — the nights
// would overlap someone else's stay and corrupt both bills — so a
// returning guest is always a new stay; this is what carries their old
// balance into view rather than into the room record.
export async function loadPriorBalance(branchId, name, phone) {
  const live = q => q.not('full_name', 'ilike', '[merged into%')
  const digits = (phone || '').replace(/\D/g, '')
  let guestId = null
  if (digits) {
    // A retired record KEEPS its phone number (the merge only renames it),
    // so a phone match can land on one. Follow the "[merged into X]" tag to
    // the surviving record instead of reporting "no debt" for it.
    const { data } = await supabase.from('guests')
      .select('id, full_name').eq('branch_id', branchId).eq('phone_norm', digits).maybeSingle()
    if (data) {
      const m = /^\[merged into (.+?)\]/i.exec(data.full_name || '')
      if (m) {
        const { data: survivor } = await live(supabase.from('guests')
          .select('id').eq('branch_id', branchId).eq('full_name', m[1].trim())).limit(1)
        guestId = survivor?.[0]?.id || null
      } else guestId = data.id
    }
  }
  if (!guestId) {
    const key = nameKey(name)
    if (!key) return { amount: 0, billedTo: null }
    const { data } = await live(supabase.from('guests')
      .select('id').eq('branch_id', branchId).eq('name_key', key))
      .order('created_at').limit(1)
    guestId = data?.[0]?.id || null
  }
  if (!guestId) return { amount: 0, billedTo: null }
  const o = (await loadOwedByGuests([guestId]))[guestId]
  return { amount: o?.amount || 0, billedTo: o?.notes.length ? o.notes.join('; ') : null }
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
      // served: the name, not just the id — the guest's invoice names who
      // served each line (Chris, 25 October 2026). This embed is already
      // proven on orders elsewhere in this file, so it is not a guess.
      .select('id, business_date, served_by, served:served_by(full_name), settlement, approval_status, decision_note, order_items(id, category, location_id, description, qty, unit_price, amount, order_type, damage_reason, writeoff_note, pr_meal)')
      .eq('stay_id', stayId).order('business_date', { ascending: false }),
    supabase.from('payments')
      .select('id, business_date, method, amount, is_overstay, remark, location_id, applied_to, applied_location_id, received_by, collected:stock_locations!location_id(name)')
      .eq('stay_id', stayId).order('business_date', { ascending: false }),
    supabase.from('v_stay_folio').select('*').eq('stay_id', stayId).maybeSingle(),
    // v_stay_folio has daily_rate/billing_cycle but not the raw
    // overstay_fee or rate_applied (the rate type) — both needed to
    // pre-fill the editing form correctly.
    supabase.from('stays').select('overstay_fee, rate_applied, bill_to, bill_to_guest_id, guest_id, checked_in_at, pre_reopen_actual_out, reopen_count, is_migrated').eq('id', stayId).maybeSingle(),
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
  // What has already been ticked off, charge by charge (migration 505).
  // Keyed by order_item_id, with the room charge under 'room' — the one
  // payable thing on a folio that is not an order line.
  const paidByItem = { room: 0 }
  // And WHO recorded it (564). A charge settled by the department that
  // sold it carries that department's name and the person's, so the
  // front desk can see on the bill that the money reached them —
  // which is the whole point of the department recording it.
  const receiptByItem = {}
  const { data: ticked } = await supabase.from('payment_items')
    .select(`order_item_id, amount, recorded_at, payments!inner(stay_id),
             dept:received_location_id(name), who:recorded_by(full_name)`)
    .eq('payments.stay_id', stayId)
  for (const t of (ticked || [])) {
    const k = t.order_item_id || 'room'
    paidByItem[k] = (paidByItem[k] || 0) + Number(t.amount || 0)
    if (t.dept?.name) {
      receiptByItem[k] = {
        dept: t.dept.name,
        by: t.who?.full_name || null,
        at: t.recorded_at || null,
      }
    }
  }

  return { orders: orders || [], payments: payments || [], folio: folio || null, stay: stay || null,
           departmentCredit, billedToYou, paidByItem, receiptByItem }
}

// Was this same money already put on this same bill a moment ago?
//
// Ifeanyi Emmanuel's room 403 on 15 September took ₦20,000 at 13:41:28
// and ₦20,000 again at 13:47:17 — one night at ₦20,000, from the same
// person at the same desk. The existing guards could not catch it. The
// "more than the bill" one needs the new payment to EXCEED what is
// owing, and ₦20,000 against ₦20,000 does not; the "already settled"
// one reads the screen's own figure, which still showed ₦20,000 owing
// because the first payment had not come back yet. That is the whole
// problem: on a slow connection the attendant cannot see that it
// landed, so they do the sensible thing and enter it again.
//
// So this asks the database rather than the screen. Any payment on
// this stay in the last quarter of an hour that adds up to exactly
// what is about to be saved is treated as a probable repeat. Exactly,
// not approximately — two genuine payments of the same round figure
// within fifteen minutes are rare, and the person is asked rather than
// stopped, so a real second payment costs one tap.
export async function checkRepeatPayment(stayId, amount) {
  const want = Math.round(Number(amount) * 100) / 100
  if (!stayId || !(want > 0)) return null
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  const { data, error } = await supabase.from('payments')
    .select('id, amount, created_at, received_by')
    .eq('stay_id', stayId).gte('created_at', since)
    .order('created_at', { ascending: false })
  if (error) return null                   // never block a payment over this
  const rows = data || []
  if (!rows.length) return null

  const sum = rows.reduce((s, p) => s + Number(p.amount || 0), 0)
  const single = rows.find(p => Math.abs(Number(p.amount) - want) < 0.009)
  const hit = single || (Math.abs(sum - want) < 0.009 ? rows[0] : null)
  if (!hit) return null

  let who = ''
  if (hit.received_by) {
    const { data: st } = await supabase.from('staff')
      .select('full_name').eq('id', hit.received_by).maybeSingle()
    who = st?.full_name || ''
  }
  const mins = Math.max(1, Math.round((Date.now() - new Date(hit.created_at).getTime()) / 60000))
  return { amount: Number(single ? hit.amount : sum), minutesAgo: mins, who }
}

// Which charges a payment settles, when nobody said.
//
// The rule is the folio's own, stated once more here because the save
// path cannot see the screen: untagged money covers the ROOM first,
// then charges oldest first. Money already paid and already ticked is
// accounted for before this payment gets a look, so the same charge is
// never settled twice.
//
// Returns [{ orderItemId | null, amount }] — a null id being the room.
// On any failure it returns nothing: the payment itself is already
// saved and correct, and a missing allocation is a smaller wrong than
// a wrong one.
async function _autoAllocate(stayId, amount) {
  try {
    const pay = Number(amount || 0)
    if (!stayId || !(pay > 0)) return []
    const [{ data: folio }, { data: orders }, { data: ticked }] = await Promise.all([
      supabase.from('v_stay_folio')
        .select('room_charge, overstay_charge, total_paid').eq('stay_id', stayId).maybeSingle(),
      supabase.from('orders')
        .select('id, business_date, created_at, settlement, approval_status, order_items(id, amount, order_type)')
        .eq('stay_id', stayId),
      supabase.from('payment_items')
        .select('order_item_id, amount, payments!inner(stay_id)').eq('payments.stay_id', stayId),
    ])
    if (!folio) return []

    const tickedOn = {}
    for (const t of (ticked || [])) {
      const k = t.order_item_id || 'room'
      tickedOn[k] = (tickedOn[k] || 0) + Number(t.amount || 0)
    }

    // Same filter as v_stay_folio.orders_charge: charged to the room,
    // approved, and neither a write-off nor a staff order.
    const lines = (orders || [])
      .filter(o => o.settlement === 'charged_to_room' && (o.approval_status || 'approved') === 'approved')
      .flatMap(o => (o.order_items || [])
        .filter(li => li.order_type !== 'pr_damage' && li.order_type !== 'staff')
        .map(li => ({ key: li.id, amount: Number(li.amount || 0), at: `${o.business_date} ${o.created_at}` })))
      .sort((a, b) => a.at.localeCompare(b.at))

    const inOrder = [{
      key: 'room',
      amount: Number(folio.room_charge || 0) + Number(folio.overstay_charge || 0),
    }].concat(lines)

    // Money already on the bill that named no charge — everything paid
    // BEFORE this payment, less everything ticked.
    const tickedTotal = Object.values(tickedOn).reduce((t, v) => t + v, 0)
    let older = Math.max(0, Number(folio.total_paid || 0) - pay - tickedTotal)

    const out = []
    let pot = pay
    for (const x of inOrder) {
      let owed = Math.max(0, x.amount - Number(tickedOn[x.key] || 0))
      if (owed <= 0.009) continue
      const byOlder = Math.min(older, owed)
      older -= byOlder
      owed -= byOlder
      if (owed <= 0.009 || pot <= 0.009) continue
      const take = Math.min(pot, owed)
      pot -= take
      out.push({ orderItemId: x.key === 'room' ? null : x.key, amount: Math.round(take * 100) / 100 })
      if (pot <= 0.009) break
    }
    return out
  } catch { return [] }
}

// A guest paying part POS and part cash (or transfer) is one
// settlement but several tenders in the ledger — same split-row
// pattern as Credit's split repayments. parts is [{method, amount}],
// already filtered to non-zero entries by the caller.
async function _recordStayPayment({ staff, stayId, businessDate, cycle, parts, isOverstay,
                                    locationId = null, appliedTo = null, appliedLocationId = null,
                                    items = null }) {
  // Two different questions, deliberately kept apart (migration 496):
  //   location_id  — whose POS or cash drawer TOOK the money
  //   applied_to   — which part of the bill it CLEARS
  // A guest can settle the restaurant bill in cash at Reception, so the
  // answers are often different and neither implies the other.
  const applied = appliedTo === 'department' && appliedLocationId ? 'department'
    : appliedTo === 'room' ? 'room' : null
  const rows = parts.filter(p => Number(p.amount) > 0).map(p => ({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    method: p.method, amount: Number(p.amount), is_overstay: !!isOverstay, cycle,
    received_by: staff.id,
    // Department whose POS/cash took the money; empty = Reception (migration 336).
    location_id: locationId || null,
    applied_to: applied,
    applied_location_id: applied === 'department' ? appliedLocationId : null,
  }))
  if (!rows.length) return
  const { data: saved, error } = await supabase.from('payments').insert(rows).select('id, amount')
  if (error) throw error

  // What the front desk TICKED (migration 505). items is
  // [{ orderItemId | null, amount }] — a null id means the room charge.
  //
  // Spread across the payment rows in order, each row taking what it is
  // worth and no more.
  //
  // These used to all go on the FIRST row, on the reasoning that a
  // settlement split across POS and cash is one event and which tender
  // paid which charge is not a thing anybody knows. The total was right
  // and every department figure was right — but it left rows like
  // chigozie promise's ₦26,000 in Nnewi 207 carrying a single ₦30,000
  // tick, which breaks the one rule that makes the ticks worth reading:
  // a payment can never settle more than it is worth. Splitting a tick
  // across two tenders invents nothing, because the two tenders were
  // one settlement to begin with.
  //
  // Written after the payment, so a failure here cannot leave money
  // unrecorded. If it fails the payment still stands — said plainly,
  // the same way a part-saved stock order is, so nobody enters it twice.
  // Nothing ticked? Work it out rather than leaving it unrecorded.
  //
  // A department only gets its money when the charges it sold are known
  // to be settled, and Reception can only hand over what it can see. If
  // an untitcked payment settled nothing in particular, every department
  // figure downstream would quietly understate — and it would depend on
  // the desk remembering to tick, which is not a system.
  //
  // So an untagged payment covers the bill in the same order the folio
  // already shows on screen: the room first, then charges oldest first.
  // The record and the screen therefore say the same thing, and nobody
  // has to do anything they were not already doing.
  const picked = (items || []).filter(i => Number(i.amount) > 0).length
    ? items.filter(i => Number(i.amount) > 0)
    : await _autoAllocate(stayId, Number(rows.reduce((t, r) => t + Number(r.amount), 0)))
  if (picked.length && saved?.length) {
    const spread = []
    let row = 0
    let roomLeft = Number(saved[0].amount || 0)
    for (const i of picked) {
      let left = Number(i.amount)
      while (left > 0.009 && row < saved.length) {
        const take = Math.min(left, roomLeft)
        if (take > 0.009) {
          spread.push({
            payment_id: saved[row].id,
            order_item_id: i.orderItemId || null,
            branch_id: staff.branch_id,
            amount: Math.round(take * 100) / 100,
          })
          left -= take
          roomLeft -= take
        }
        if (roomLeft <= 0.009) { row += 1; roomLeft = Number(saved[row]?.amount || 0) }
      }
    }
    const { error: e2 } = await supabase.from('payment_items').insert(spread)
    if (e2) {
      throw Object.assign(new Error(
        `The payment WAS recorded, but which charges it settles was not (${e2.message}). `
        + 'Do not enter it again — open the payment and set it there, or tell your manager.'),
        { partial: true })
    }
  }
}

async function _checkOutStay(stayId, actualOut) {
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
// Checked-out guests who still OWE something — no time limit, because a
// debt does not expire. "Recently checked out" only searches 14 days and
// caps at 30 results, with nothing marking who owes: a guest who left
// three weeks ago with a balance falls off that search even though their
// folio, room history and balance are all still sitting there untouched.
// Oldest departure first, since that is the debt most at risk of being
// forgotten. Uses the same folio a live stay does — payment can already
// be recorded on it without reopening anything.
export async function loadCheckoutsStillOwing(branchId) {
  // The view carries status, actual_out, guest_id and room_id itself, so
  // fetch the owing folios from it alone, then look rooms and guests up
  // by id. Previously embedded `stays` into the view, which cannot be
  // resolved (no foreign key from a view back to its own source table),
  // and the caller swallows errors — so the list would have stayed empty
  // with nothing to say why.
  const { data: folios, error } = await supabase.from('v_stay_folio')
    .select('stay_id, actual_out, outstanding, room_id, guest_id')
    .eq('branch_id', branchId).eq('status', 'checked_out')
    .gt('outstanding', 0.009)
    .order('actual_out', { ascending: true })
  if (error) throw error
  const rows = folios || []
  if (!rows.length) return []

  // Who each balance is BILLED TO — the person the front desk should chase.
  const { data: billing } = await supabase.from('stays')
    .select('id, bill_to, bill_to_guest_id').in('id', rows.map(r => r.stay_id))
  const billBy = Object.fromEntries((billing || []).map(b => [b.id, b]))
  const roomIds = [...new Set(rows.map(r => r.room_id).filter(Boolean))]
  const guestIds = [...new Set([
    ...rows.map(r => r.guest_id), ...(billing || []).map(b => b.bill_to_guest_id),
  ].filter(Boolean))]
  const [{ data: rooms }, { data: guests }] = await Promise.all([
    roomIds.length ? supabase.from('rooms').select('id, room_number').in('id', roomIds)
                   : Promise.resolve({ data: [] }),
    guestIds.length ? supabase.from('guests').select('id, full_name, phone').in('id', guestIds)
                    : Promise.resolve({ data: [] }),
  ])
  const roomBy = Object.fromEntries((rooms || []).map(r => [r.id, r]))
  const guestBy = Object.fromEntries((guests || []).map(g => [g.id, g]))
  return rows.map(r => ({
    stay_id: r.stay_id, actual_out: r.actual_out, outstanding: Number(r.outstanding),
    room_number: roomBy[r.room_id]?.room_number,
    guest_name: guestBy[r.guest_id]?.full_name,
    guest_phone: guestBy[r.guest_id]?.phone,
    // the linked guest's name if there is one, otherwise whatever was typed
    billed_to: (billBy[r.stay_id]?.bill_to_guest_id
      && billBy[r.stay_id].bill_to_guest_id !== r.guest_id
      ? guestBy[billBy[r.stay_id].bill_to_guest_id]?.full_name : null)
      || billBy[r.stay_id]?.bill_to || null,
  }))
}

export async function searchRecentCheckouts(branchId, query) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stays')
    .select(`id, check_in_date, scheduled_out, actual_out, checked_in_at, checked_out_at,
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

// A reserved guest has arrived: the stay becomes Occupied now. The database
// trigger (set_checked_in_at) stamps the real check-in time. Reads the row
// back so a blocked update (no rights) is reported instead of looking done.
export async function checkInReservation(stayId) {
  const { data, error } = await supabase.from('stays')
    .update({ status: 'occupied' }).eq('id', stayId).eq('status', 'reserved').select('id')
  if (error) throw error
  if (!data?.length) throw new Error('Could not check this guest in. It may already be checked in, or you may not have the right to do it.')
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

// Rooms that are not really rooms — the GM's office and anything else
// flagged is_internal. Read from the flag rather than a room number, so
// a genuine room 209 at another branch is never hidden by accident.
export async function loadInternalRoomIds(branchId) {
  const { data, error } = await supabase.from('rooms')
    .select('id').eq('branch_id', branchId).eq('is_internal', true)
  if (error) return []
  return (data || []).map(r => r.id)
}

// Move a stay's leaving date and NOTHING else.
//
// updateStayDetails writes the rate, the cycle, the reason and the
// bill-to alongside the date, so calling it to change one field means
// re-sending the other five correctly or quietly wiping them. This is
// for the one case where only the date is wrong: the guest has paid
// for nights beyond the date on the board.
//
// That case was everywhere. On 16 October three of the four rooms
// showing "Past due" at Awka were paid up — Mr Ilowu's 203 and 204 and
// Mr Ngoka's 105 — because paying has never moved the date and nobody
// had thought to move it by hand. Only Mr Obitex in 207 was really
// overstaying, and he was indistinguishable from the other three.
export async function extendStayTo(stayId, scheduledOut) {
  const { error } = await supabase.from('stays')
    .update({ scheduled_out: scheduledOut }).eq('id', stayId)
  if (error) throw error
}

// How far each occupied room's ROOM money actually reaches, so the board
// can tell a guest who is paid up from one who is overstaying. Room
// money is the allocation with no order_item_id — nights, not food.
export async function loadPaidThrough(branchId) {
  const { data: folios, error } = await supabase.from('v_stay_folio')
    .select('stay_id, daily_rate, check_in_date, scheduled_out')
    .eq('branch_id', branchId).eq('status', 'occupied')
  if (error) return {}
  const rows = folios || []
  if (!rows.length) return {}
  const { data: ticks } = await supabase.from('payment_items')
    .select('amount, payments!inner(stay_id, branch_id)')
    .eq('payments.branch_id', branchId).is('order_item_id', null)
  const roomMoney = {}
  for (const t of (ticks || [])) {
    const k = t.payments?.stay_id
    if (k) roomMoney[k] = (roomMoney[k] || 0) + Number(t.amount || 0)
  }
  const out = {}
  for (const f of rows) {
    const rate = Number(f.daily_rate || 0)
    if (!(rate > 0) || !f.check_in_date) continue
    const nights = Math.floor((roomMoney[f.stay_id] || 0) / rate)
    out[f.stay_id] = addDays(f.check_in_date, nights)
  }
  return out
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
             staff:received_by(full_name), location_id,
             collected:stock_locations!location_id(name),
             stays(id, rooms(room_number), guests!guest_id(full_name))`)
    .eq('branch_id', branchId).eq('business_date', date)
    .order('created_at', { ascending: false })
  if (error) throw error
  // Money a guest paid at another department's till (e.g. "charge to a
  // room" settled at MainBar) belongs to THAT department's sales and
  // cash-up. Showing it here counted it twice and inflated Front Desk.
  // Payments with no department, or taken at Reception/Front Desk, stay.
  return (data || []).filter(p => !p.location_id || /reception|front/i.test(p.collected?.name || ''))
}

// Deletes an entire training booking — stay, its orders/order_items,
// and its payments, in one RPC. Already enforces GM/Admin at the
// database level (is_supervisor()), confirmed against its real body
// rather than assumed; the app-side role check below is just for
// showing the right UI, not the actual security.
async function _deleteStay(stayId) {
  const { error } = await supabase.rpc('delete_stay', { target: stayId })
  if (error) throw error
}

// ---------- Settings: room rates and the branch overstay default ----------
// rooms UPDATE and branches UPDATE are both genuinely enforced at the
// database level (can_manage_rooms(), is_supervisor()) — confirmed
// directly, not assumed from the reference app's client-side checks.

export async function loadRoomsForSettings(branchId) {
  const { data, error } = await supabase.from('rooms')
    .select('id, room_number, rate_standard, rate_alternate, rate_short, rate_special, is_active, room_categories(name)')
    .eq('branch_id', branchId)
  if (error) throw error
  return (data || []).sort((a, b) =>
    String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

export async function updateRoomRates(roomId, patch) {
  const { error } = await supabase.from('rooms').update(patch).eq('id', roomId)
  if (error) throw error
}

// Bookings already made on a room, with the rate each one captured
// (Chris, 26 October 2026).
//
// A stay stores its own daily rate at the moment it is created, and that
// is deliberate: without it, changing a room's rate today would silently
// re-price every booking ever made on it. The cost of that rule is that
// changing a rate does NOT reach a reservation already on the books, and
// nothing said so — two rooms were reserved one evening and the rate
// raised the next morning, and the gap only surfaced when the balances
// looked wrong.
//
// Reserved only. An occupied or checked-out stay is a guest already in
// the building whose rate was agreed when they arrived; re-opening that
// question is a different act from correcting a booking nobody has
// turned up for yet.
export async function loadReservationsOnRoom(roomId) {
  const { data, error } = await supabase.from('stays')
    .select('id, check_in_date, scheduled_out, daily_rate, rate_applied, guests!guest_id(full_name)')
    .eq('room_id', roomId).eq('status', 'reserved')
    .order('check_in_date')
  if (error) throw error
  return data || []
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
// Room-rate period progress across every occupied, multi-night stay —
// nights consumed vs remaining against the planned check-in→scheduled-
// out window, purely time-based. Deliberately independent of payment
// status, same reasoning as the per-guest version of this on Folio: it
// tracks the room rate's own consumption of the booked period, not
// whether it's been paid for or what else has been charged.
export async function loadRoomRateProgress(branchId) {
  const { data: folios, error: e1 } = await supabase.from('v_stay_folio')
    .select('stay_id, check_in_date, scheduled_out, daily_rate, nights, room_charge')
    .eq('branch_id', branchId).eq('status', 'occupied').gt('nights', 1)
  if (e1) throw e1
  if (!folios?.length) return []

  const { data: stays, error: e2 } = await supabase.from('stays')
    .select('id, rooms(room_number, is_internal), guests!guest_id(full_name)')
    .in('id', folios.map(f => f.stay_id))
  if (e2) throw e2
  const stayById = Object.fromEntries((stays || []).map(s => [s.id, s]))

  const today = lagosToday()
  return folios.map(f => {
    const totalNights = Number(f.nights)
    const dailyRate = Number(f.daily_rate)
    const rawElapsed = Math.round((new Date(today) - new Date(f.check_in_date)) / 864e5)
    const nightsElapsed = Math.max(0, Math.min(totalNights, rawElapsed))
    const nightsLeft = Math.max(0, totalNights - nightsElapsed)
    const consumed = nightsElapsed * dailyRate
    const remaining = Math.max(0, Number(f.room_charge) - consumed)
    return {
      stay_id: f.stay_id,
      room_number: stayById[f.stay_id]?.rooms?.room_number,
      is_internal: !!stayById[f.stay_id]?.rooms?.is_internal,
      guest_name: stayById[f.stay_id]?.guests?.full_name,
      scheduled_out: f.scheduled_out,
      totalNights, nightsElapsed, nightsLeft, consumed, remaining,
      pctElapsed: totalNights > 0 ? Math.min(100, Math.round((nightsElapsed / totalNights) * 100)) : 0,
    }
  }).sort((a, b) => String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))
}

// Reception's own daily-close dashboard — POS/cash collected today,
// the full deferred (outstanding) picture, room-rate period progress
// for multi-night stays, and a roster of everyone actually in-house
// right now. That last part matters: deferred only lists guests with
// a positive balance, so a guest sitting at exactly zero (fully
// settled — an advance guest mid-stay with no new charges, or someone
// who simply made no payment or order today) would otherwise be
// invisible on this screen, easily mistaken for having checked out.
export async function loadReceptionDashboard(branchId, date) {
  const [{ data: todayPayments, error: e1 }, { data: occ, error: e5 },
         { data: handedOver, error: e6 }] = await Promise.all([
    supabase.from('payments')
      .select('method, amount, stay_id, location_id').eq('branch_id', branchId).eq('business_date', date),
    supabase.from('v_occupancy_today')
      .select('stay_id, room_number, guest_name, outstanding')
      .eq('branch_id', branchId).eq('status', 'occupied'),
    // What departments have recorded being physically handed out of the
    // money the guest paid at this desk (564). Joined through payments so
    // only this branch and this day's takings come back.
    supabase.from('payment_items')
      .select('amount, dept:received_location_id(name), payments!inner(method, business_date, branch_id, location_id)')
      .not('received_location_id', 'is', null)
      .eq('payments.branch_id', branchId)
      .eq('payments.business_date', date),
  ])
  if (e1) throw e1
  if (e5) throw e5
  // Loudly, not silently. If this one query fails the desk is shown MORE
  // money than it holds, which is the error that ends in someone being
  // asked to account for cash they handed over hours earlier.
  if (e6) throw e6

  // Room payments taken through ANOTHER department's POS/cash (location_id set)
  // belong to that department's total, not Reception's (migration 336).
  const atFrontDesk = (todayPayments || []).filter(p => !p.location_id)
  const took = (m) => atFrontDesk.filter(p => p.method === m)
    .reduce((s, p) => s + Number(p.amount), 0)

  // Chris, 20 October 2026: "The reception only keeps money paid for
  // room/stays, and the other departments take their own payments."
  //
  // So a guest's payment is Reception's only until the slip and the cash
  // are handed over. Before this, recording a handover settled the charge
  // and moved the money onto the department's figure but left it on
  // Reception's as well — the same naira counted on two tills, which is
  // the exact discrepancy 564 was built to end.
  //
  // Deducted on the PAYMENT's day, not the day it was recorded, so both
  // sides move together: get_daily_financials credits the department on
  // p.business_date too. A handover recorded late therefore changes the
  // day the money was taken, which is the honest answer — and the reason
  // a handover left unconfirmed belongs on Needs a look.
  const given = (handedOver || []).filter(h => !h.payments?.location_id)
  const gave = (m) => given.filter(h => h.payments?.method === m)
    .reduce((s, h) => s + Number(h.amount || 0), 0)
  const posGiven = gave('pos')
  const cashGiven = gave('cash')
  const pos = took('pos') - posGiven
  const cash = took('cash') - cashGiven

  // Who it went to, so a figure that dropped can be explained without
  // opening a second screen.
  const handoverByDept = {}
  for (const h of given) {
    const name = h.dept?.name || 'a department'
    handoverByDept[name] = (handoverByDept[name] || 0) + Number(h.amount || 0)
  }
  const handedToDepartments = {
    pos: posGiven, cash: cashGiven, total: posGiven + cashGiven,
    byDept: Object.entries(handoverByDept)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
  }

  const paidTodayByStay = {}
  for (const p of (todayPayments || [])) {
    if (!p.stay_id) continue
    paidTodayByStay[p.stay_id] = (paidTodayByStay[p.stay_id] || 0) + Number(p.amount)
  }
  // 'paid' — settled something today. 'credit' — still owes and paid
  // nothing today (silently accruing). 'settled' — zero balance and
  // no activity today (e.g. mid-stay on an advance); still shown, not
  // dropped, precisely so the room doesn't read as vacant.
  const inHouse = (occ || []).map(o => {
    const paidToday = paidTodayByStay[o.stay_id] || 0
    const outstanding = Number(o.outstanding || 0)
    const status = paidToday > 0 ? 'paid' : outstanding > 0.009 ? 'credit' : 'settled'
    return { stay_id: o.stay_id, room_number: o.room_number, guest_name: o.guest_name, outstanding, paidToday, status }
  }).sort((a, b) => String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true }))

  const [deferred, roomRateProgress] = await Promise.all([
    loadGuestBalances(branchId),
    loadRoomRateProgress(branchId),
  ])
  const deferredTotal = deferred.reduce((s, g) => s + g.outstanding + g.departmentCredit + g.billedToYou, 0)
  const roomRateRemainingTotal = roomRateProgress.reduce((s, r) => s + r.remaining, 0)

  return { pos, cash, handedToDepartments, deferred, deferredTotal, roomRateProgress, roomRateRemainingTotal, inHouse }
}

// Rooms booked but not yet arrived, with what the booking COMES TO.
// loadUpcomingReservations (above) answers "who is coming"; this answers
// "what is it worth and has any of it been paid". Kept out of the owing
// figures, and shown on its own so an unpaid group booking is still
// visible while a deposit can still be asked for.
export async function loadReservedValue(branchId) {
  const { data, error } = await supabase.from('v_stay_folio')
    .select('stay_id, check_in_date, scheduled_out, total_due, total_paid, outstanding, room_id, guest_id')
    .eq('branch_id', branchId).eq('status', 'reserved')
    .order('check_in_date', { ascending: true })
  if (error) return []
  const rows = data || []
  if (!rows.length) return []
  const [rooms, guests] = await Promise.all([
    supabase.from('rooms').select('id, room_number').in('id', rows.map(r => r.room_id).filter(Boolean)),
    supabase.from('guests').select('id, full_name').in('id', rows.map(r => r.guest_id).filter(Boolean)),
  ])
  const roomById = Object.fromEntries((rooms.data || []).map(r => [r.id, r.room_number]))
  const guestById = Object.fromEntries((guests.data || []).map(g => [g.id, g.full_name]))
  return rows.map(r => ({
    stayId: r.stay_id,
    room: roomById[r.room_id] || '—',
    guest: guestById[r.guest_id] || 'Guest',
    arrives: r.check_in_date,
    leaves: r.scheduled_out,
    total: Number(r.total_due || 0),
    paid: Number(r.total_paid || 0),
    unpaid: Number(r.outstanding || 0),
  }))
}

export async function loadGuestBalances(branchId, staffId) {
  // Reserved rooms are NOT debt. A booking's whole stay shows as due with
  // nothing paid, because the guest has not arrived — eleven PSN rooms
  // held for November were reading as ₦1,650,000 owed, five times every
  // real balance put together, which made the figure useless. A
  // reservation becomes owed when the guest checks in; until then it is
  // expected business and is reported separately
  // (loadReservedValue).
  const { data: folios, error: e1 } = await supabase.from('v_stay_folio')
    .select('stay_id, billing_cycle, outstanding')
    .eq('branch_id', branchId).gt('outstanding', 0.009)
    .neq('status', 'reserved')
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
    .neq('status', 'reserved')   // same reasoning as above: not owed yet
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
    .select(`id, stay_id, branch_id, business_date, method, amount, is_overstay, remark, received_by,
             staff:received_by(full_name),
             stays(check_in_date, scheduled_out, actual_out, rooms(room_number), guests!guest_id(full_name))`)
    .eq('branch_id', branchId).gte('business_date', since)
    .order('business_date', { ascending: false })
  if (error) throw error
  return data || []
}

// Change what an EXISTING payment clears (migration 496).
//
// Money paid forward for the room should stay against the room, not be
// quietly absorbed by a bar tab that arrives afterwards. New payments
// say so when they are taken; this is for the ones already on the book
// — Mr Michael Ike's ₦60,000 of 14 October among them, which was a
// fortnight paid in advance and read as an overpayment because nothing
// recorded what it was for.
//
// Only the allocation moves. The amount, the date, the method and whose
// till took it are all left exactly as they are.
// Not wired to any screen since 20 October 2026 — the control was removed
// from the folio. Kept because it is the repair for a payment pointed at
// the wrong part of a bill, and that repair is made by id, not by a
// dropdown on a live guest's bill.
async function _setPaymentAllocation(paymentId, appliedTo, appliedLocationId = null) {
  const applied = appliedTo === 'department' && appliedLocationId ? 'department'
    : appliedTo === 'room' ? 'room' : null
  const { error } = await supabase.from('payments')
    .update({
      applied_to: applied,
      applied_location_id: applied === 'department' ? appliedLocationId : null,
    })
    .eq('id', paymentId)
  if (error) throw error
}

// A department records the money it was physically handed for its room
// charges (564). Chris's decision, 20 October 2026: the front desk no
// longer allocates a guest's payment against charges — the department
// that is owed records what it actually received, and that entry is
// what settles the charge and what its till counts.
//
// The function ties the money to that department's oldest unpaid
// charges on that stay and to the guest's real payments, so nothing can
// be recorded that the guest never paid, and nothing twice.
async function _recordDepartmentReceipt({ stayId, locationId, pos, cash }) {
  const { data, error } = await supabase.rpc('record_department_receipt', {
    p_stay: stayId, p_location: locationId,
    p_pos: Number(pos) || 0, p_cash: Number(cash) || 0,
  })
  if (error) throw error
  return data
}

// Migration 508's department_handovers table was never created — the
// table does not exist in the database, and the three functions that
// read and wrote it were never wired to a screen. They are removed
// here rather than left to be found and used (20 October 2026). The
// handover is recorded by the department itself now, against the
// charges, by record_department_receipt.


// Move a room payment to the department whose till took the money, or back to
// Reception (locationId = null). Server decides who may (migration 336).
// Not wired to any screen since 20 October 2026 (see above): a room payment
// at the front desk is Reception's by definition now, and a department's own
// money comes in through record_department_receipt, which also ties it to the
// charge it settles. Moving one of those with this would have left the till
// figure and the settled charge naming different departments.
async function _setPaymentDepartment(paymentId, locationId) {
  const { error } = await supabase.rpc('set_payment_department', {
    p_payment: paymentId, p_location: locationId || null })
  if (error) throw error
}

// Move only PART of a lump payment to a department (migration 339); the
// guest's total paid does not change.
async function _splitPaymentToDepartment(paymentId, amount, locationId) {
  const { error } = await supabase.rpc('split_payment_to_department', {
    p_payment: paymentId, p_amount: amount, p_location: locationId })
  if (error) throw error
}

// What was taken, when, and how it was recovered (570).
//
// Nothing records which sales a repayment paid off — credit_repayments
// only moves a balance. The function rebuilds the chain at read time by
// running repayments against that customer's credit sales oldest first,
// grouped the same way the balance itself is kept, so the two can never
// disagree.
export async function loadCreditChain(branchId, customerId, days = 120) {
  const { data, error } = await supabase.rpc('credit_chain', {
    p_branch: branchId, p_customer: customerId || null, p_days: days,
  })
  if (error) throw error
  return data || []
}

// A guest's bill put on credit, against a named account (567).
//
// Chris, 21 October 2026. A guest who leaves owing was only ever an
// implicit balance on a banner; the app's whole debt machinery —
// customer accounts, the Credit page, Recovery, debtRecovered — could
// not see room debt at all. This moves the debt off the bill and onto
// an account that machinery already understands.
//
// One RPC, not three writes, deliberately: it clears the folio, books
// the sale and records the credit line together. Three separate writes
// could clear a bill and then fail to record the debt, which is a
// guest's money erased by a dropped connection.
export async function recordStayCredit({ stayId, amount, customerId, customerName, note }) {
  const { data, error } = await supabase.rpc('record_stay_credit', {
    p_stay: stayId,
    p_amount: Number(amount),
    p_customer: customerId || null,
    p_customer_name: customerId ? null : (customerName || null),
    p_note: note || null,
  })
  if (error) throw error
  return data
}

// Room-rate debt recovered (565). Chris, 20 October 2026: a guest who
// checked out owing for the ROOM and pays weeks later is recovering a
// debt, and nothing said so. get_daily_financials only ever counted the
// department side — payment_items against order_items — so Sir Ben's
// ₦62,300 landed in Reception's takings and appeared nowhere as money
// coming back.
//
// This is the room side: money on a stay that had already checked out,
// paid on a later day, less any part already tied to a department's
// charge (that part is counted by get_daily_financials and must not be
// counted twice). It belongs to Reception, so the caller only adds it
// when looking at the whole branch.
//
// Kept as its own function rather than folded into get_daily_financials:
// that one decides every department's Total Sales, and a transcription
// slip inside it would be a slip in everybody's money.
export async function loadStayDebtRecovered(branchId, date) {
  const { data, error } = await supabase.rpc('stay_debt_recovered', {
    p_branch: branchId, p_date: date,
  })
  if (error) throw error
  return {
    total: Number(data?.total || 0),
    byMethod: data?.byMethod || {},
    rows: data?.rows || [],
  }
}

// What a department collected on room folios on a day: {pos, cash}. Part of
// that department's Match Total Sales.
export async function loadFolioCollectedAt(branchId, date, locationId) {
  const { data, error } = await supabase.rpc('folio_collected_at', {
    p_branch: branchId, p_date: date, p_location: locationId })
  if (error) throw error
  return { pos: Number(data?.pos || 0), cash: Number(data?.cash || 0) }
}

// GM/admin cleanup for a practice payment — a single, self-contained
// delete. Unlike deleting a whole training booking (delete_stay),
// this never touches the stay itself: if training happened against a
// real, live room, the room's actual booking and every other real
// charge/payment on it are completely untouched — only the one
// erroneous payment row goes.
// Correcting a room payment that was keyed wrong (568).
//
// The amount, the method and the DATE. The date is the one that was
// invisible until 568 taught log_room_payment_change to record it —
// a payment moved to another day shifts which day's takings it counts
// towards, which is how ₦24,800 came to sit in September on a stay
// that ran in October.
//
// A plain update: the trigger writes the before and after to the audit
// trail with the mover's name, and RLS decides who may. Nothing is
// recomputed here — the folio reads payments directly, so the bill
// follows on its own.
async function _updateRoomPayment(paymentId, { amount, method, businessDate }) {
  const patch = {}
  if (amount != null && amount !== '') patch.amount = Number(amount)
  if (method) patch.method = method
  if (businessDate) patch.business_date = businessDate
  if (!Object.keys(patch).length) return
  const { error } = await supabase.from('payments').update(patch).eq('id', paymentId)
  if (error) throw error
}

async function _deleteRoomPayment(paymentId) {
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

async function _deleteOrderItem(orderItemId, orderId) {
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
// Every room charge on one day, whichever department made it.
//
// This used to take a CATEGORY and filter on it. Category is only ever
// 'food', 'minimart' or 'drink' — so every bar resolved to 'drink' and
// MainBar and OpenBar were served the same combined list, each reading
// the other's charges as its own. OpenBar's ₦12,600 had been showing on
// MainBar since 3 October.
//
// So the day's rows come back whole and the DEPARTMENT is resolved per
// line by roomChargeDept() below, the same way department_room_charges
// does it in SQL. One rule, two places, stated once.
export async function loadRoomCharges(branchId, date) {
  const { data, error } = await supabase.from('order_items')
    .select(`id, description, qty, unit_price, amount, order_id, order_type, damage_reason, writeoff_note, pr_meal,
             no_stock_declared, category, location_id,
             orders!inner(id, business_date, branch_id, served_by, created_at, occurred_at,
                          served:served_by(full_name),
                          stays(id, status, actual_out, rooms(room_number), guests!guest_id(full_name)))`)
    .eq('orders.branch_id', branchId).eq('orders.business_date', date)
  if (error) throw error
  const rows = data || []

  // How much has been put against each of these charges. Since 505 a
  // payment records WHICH charges it settled, so a line can finally say
  // what is still owed on it rather than only what the whole bill owes.
  // The department's Credit figure is built from this: goods charged to
  // a room and not yet settled are goods it let go on trust, exactly
  // like a credit sale.
  const itemIds = rows.map(r => r.id).filter(Boolean)
  if (itemIds.length) {
    const { data: paid } = await supabase.from('payment_items')
      .select('order_item_id, amount').in('order_item_id', itemIds)
    const byItem = {}
    for (const t of (paid || [])) {
      byItem[t.order_item_id] = (byItem[t.order_item_id] || 0) + Number(t.amount || 0)
    }
    for (const r of rows) r.paidOnLine = Number(byItem[r.id] || 0)
  } else {
    for (const r of rows) r.paidOnLine = 0
  }

  // Whether the guest's bill has been settled. Restaurant staff asked
  // for this: a meal on the list says the food left the kitchen, not
  // that anyone paid for it. A payment is recorded against the WHOLE
  // stay, so this is the folio's position — not that line's — which is
  // why it is labelled "this guest's bill", not "this meal".
  const stayIds = [...new Set(rows.map(r => r.orders?.stays?.id).filter(Boolean))]
  if (stayIds.length) {
    const { data: folios } = await supabase.from('v_stay_folio')
      .select('stay_id, outstanding, total_due').in('stay_id', stayIds)
    const by = Object.fromEntries((folios || []).map(f => [f.stay_id, f]))
    for (const r of rows) {
      const f = by[r.orders?.stays?.id]
      r.folioOutstanding = f ? Number(f.outstanding) : null
      r.stayStatus = r.orders?.stays?.status || null
    }
    // This LINE's own status (paid / unpaid / settled at Reception), so a
    // Restaurant meal is not flagged because of a bar item on the same bill.
    try {
      const { data: judged } = await supabase.rpc('department_room_charges', {
        p_branch: branchId, p_location: null, p_days: 90 })
      const byId = Object.fromEntries((judged || []).map(l => [l.id, l.status]))
      for (const r of rows) r.lineStatus = byId[r.id] || null
    } catch { /* falls back to the guest-bill wording */ }
  }
  return rows
}
// ---------- Restaurant order type: PR/Damage and Staff write-offs ----------
// Standard orders are unchanged — they go through the normal basket/
// payment flow. PR/Damage and Staff never collect payment at all, so
// they're a direct save, the same way the existing catalog PR/Damage
// write-off (saveWriteoff) bypasses the sales basket entirely rather
// than trying to thread "no payment required" through it.

async function _saveRestaurantWriteoff({ staff, locationId, businessDate,
                                                description, qty, unitPrice,
                                                orderType, damageReason, writeoffNote, prMeal, stockUsed,
                                                noStockDeclared }) {
  const { data: row, error } = await supabase.from('sales').insert({
    branch_id: staff.branch_id, business_date: businessDate, occurred_at: new Date().toISOString(),
    stock_item_id: null, description, location_id: locationId, tier: 'general',
    qty, unit_price: unitPrice, recorded_by: staff.id,
    order_type: orderType, damage_reason: damageReason || null, writeoff_note: writeoffNote || null,
    pr_meal: prMeal || null,
    // Only meaningful with no stock lines, and only for PR/damage
    // (migration 434) — everything else is blocked without stock.
    no_stock_declared: !stockUsed?.length && !!noStockDeclared,
  }).select('id').single()
  if (error) throw error
  if (stockUsed?.length) {
    try { await recordStockUsed(row.id, stockUsed) }
    catch (e) {
      throw partialStockError(e)
    }
  }
}

async function _chargeWriteoffToRoom({ staff, stayId, businessDate,
                                              description, qty, unitPrice,
                                              orderType, damageReason, writeoffNote, prMeal, stockUsed,
                                              noStockDeclared, locationId = null, locationName = null }) {
  assertSellingDept(locationName)
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    branch_id: staff.branch_id, stay_id: stayId, business_date: businessDate,
    settlement: 'charged_to_room', served_by: staff.id,
  }).select('id').single()
  if (oErr) throw oErr
  const { data: oi, error: iErr } = await supabase.from('order_items').insert({
    // Department recorded, no stock item, so no stock moves — same
    // reasoning as _chargeItemToRoom above. Category follows the
    // department rather than being hardcoded food.
    order_id: order.id, category: chargeCategoryFor(locationName), stock_item_id: null,
    location_id: locationId || null,
    description, qty, unit_price: unitPrice,
    order_type: orderType, damage_reason: damageReason || null, writeoff_note: writeoffNote || null,
    pr_meal: prMeal || null,
    no_stock_declared: !stockUsed?.length && !!noStockDeclared,
  }).select('id').single()
  if (iErr) {
    await supabase.from('orders').delete().eq('id', order.id)
    throw iErr
  }
  if (stockUsed?.length) {
    try { await recordOrderItemStockUsed(oi.id, stockUsed) } catch (e) { throw partialStockError(e) }
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

// Things worth asking about — deletions after a day has closed, money
// edits, blank counts, self-verified counts, reopened stays never
// re-dated, and so on (migration 460). The RPC decides nothing about
// intent; it only surfaces what would otherwise sit unseen.
export async function loadReviewFlags(branchId, days = 14) {
  const { data, error } = await supabase.rpc('review_flags', {
    p_branch: branchId, p_days: days,
  })
  if (error) throw error
  return data || []
}

// Entries belonging to one day that were changed or deleted afterwards,
// for the day's close. The audit table already held this; nothing read
// it, which is how a deleted charge could quietly return stock to a
// shelf after it had been counted.
export async function loadCorrectionsOnDate(branchId, date, locationId = null) {
  let q = supabase.from('inventory_audit')
    .select('id, happened_at, action, entity, summary, done_by_name, stock_item_id')
    .eq('branch_id', branchId)
    .eq('business_date', date)
    .in('action', ['deleted', 'edited'])
    .order('happened_at', { ascending: false })
  const { data, error } = await q
  if (error) return []
  const rows = data || []
  // inventory_audit has no location of its own, so a department view
  // narrows by the items that department actually sells rather than
  // pretending to know more than the row carries.
  if (!locationId) return rows
  const ids = [...new Set(rows.map(r => r.stock_item_id).filter(Boolean))]
  if (!ids.length) return rows
  const { data: moved } = await supabase.from('stock_movements')
    .select('stock_item_id')
    .in('stock_item_id', ids)
    .or(`from_location.eq.${locationId},to_location.eq.${locationId}`)
  const here = new Set((moved || []).map(m => m.stock_item_id))
  return rows.filter(r => !r.stock_item_id || here.has(r.stock_item_id))
}

// Mark one "Needs a look" entry as dealt with, or put it back
// (migration 463). Hides nothing — the sale, payment or count it points
// at is untouched; it only stops the same item being counted every day.
export async function setReviewHandled(branchId, key, handled) {
  const { data, error } = await supabase.rpc('set_review_handled', {
    p_branch: branchId, p_key: key, p_handled: !!handled,
  })
  if (error) throw error
  return data
}

// ---------- Staff of the Month ----------
// Per branch — each branch recognizes its own winner independently,
// not one shared across both. The banner only shows for 7 days after
// being posted; older rows stay in the table as history but the app
// treats them as expired, not deleted. Prize amount is editable per
// post (not a standing branch setting) so a past post keeps showing
// whatever was actually paid at the time, even if the amount changes later.
export async function loadStaffOfMonth(branchId) {
  const { data, error } = await supabase.from('staff_of_month')
    .select('id, staff_name, photo_url, posted_at, prize_amount')
    .eq('branch_id', branchId)
    .order('posted_at', { ascending: false }).order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  if (error) throw error
  if (!data) return null
  const daysSince = Math.round((new Date(lagosToday()) - new Date(data.posted_at)) / 864e5)
  return { ...data, isActive: daysSince >= 0 && daysSince < 7, daysSince }
}

// Uploads a new photo if one was given, then either updates today's
// post in place (a same-day correction — e.g. a typo, doesn't reset
// the week) or creates a fresh row, which is what actually restarts
// the 7-day countdown — that's what "posting" a new winner means.
// Scoped to branchId throughout, so each branch's own latest post is
// what gets found and updated, never the other branch's.
export async function postStaffOfMonth({ branchId, staffId, staffName, prizeAmount, photoFile, removePhoto, currentPhotoUrl }) {
  let photoUrl = removePhoto ? null : (currentPhotoUrl || null)
  if (photoFile) {
    const ext = (photoFile.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${branchId}/${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from('staff-photos')
      .upload(path, photoFile, { upsert: true })
    if (upErr) throw upErr
    const { data: pub } = supabase.storage.from('staff-photos').getPublicUrl(path)
    photoUrl = pub.publicUrl
  }

  const today = lagosToday()
  const { data: existing, error: e1 } = await supabase.from('staff_of_month')
    .select('id, posted_at').eq('branch_id', branchId)
    .order('posted_at', { ascending: false }).order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  if (e1) throw e1

  // Returns the post's id: the prize is linked to payroll by it, so a
  // same-day correction can replace the prize instead of doubling it.
  if (existing && existing.posted_at === today) {
    const { error } = await supabase.from('staff_of_month')
      .update({ staff_name: staffName, photo_url: photoUrl, prize_amount: prizeAmount }).eq('id', existing.id)
    if (error) throw error
    return existing.id
  } else {
    const { data: created, error } = await supabase.from('staff_of_month')
      .insert({ branch_id: branchId, staff_name: staffName, photo_url: photoUrl,
                prize_amount: prizeAmount, posted_at: today, posted_by: staffId })
      .select('id').single()
    if (error) throw error
    return created.id
  }
}

// Removes a post outright — e.g. a test entry — rather than letting
// it expire on its own. Only GM/admin can call this (is_supervisor()
// on the table); deleting the CURRENT post means the banner for that
// branch simply goes back to showing nothing until a new one is posted.
export async function deleteStaffOfMonth(id) {
  const { error } = await supabase.from('staff_of_month').delete().eq('id', id)
  if (error) throw error
}

// ---------- Rooms sold in a month (GM/admin only, enforced in the UI) ----------
// Counts bookings whose check-in falls in the same calendar month as
// the given date — the whole month if it's already fully past, or up
// to today if it's the current, still-ongoing month. Excludes GM
// Office (room 209, wherever it exists at this branch) since that's a
// permanent zero-rate placeholder stay blocking the room for internal
// use, not an actual booking — counting it would overstate real sales.
function firstOfNextMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return `${nextY}-${String(nextM).padStart(2, '0')}-01`
}
export async function loadRoomsSoldInMonth(branchId, date) {
  const monthStart = date.slice(0, 7) + '-01'
  const today = lagosToday()
  const upperBoundExclusive = date.slice(0, 7) === today.slice(0, 7)
    ? addDays(today, 1) : firstOfNextMonth(monthStart)

  // Internal rooms (GM Office) are placeholders, not sales. Read from
  // rooms.is_internal rather than a hardcoded number, so a genuine
  // room 209 at another branch is counted normally.
  const { data: internalRooms } = await supabase.from('rooms')
    .select('id').eq('branch_id', branchId).eq('is_internal', true)

  // Every stay that could TOUCH the month, not only those that began in
  // it. A guest who arrived on 28 September and left on 4 October sold
  // three nights of October, and the old query could not see them at
  // all. The lower bound is a year back, which covers any real stay
  // while keeping the query bounded.
  let q = supabase.from('stays')
    .select('check_in_date, scheduled_out, actual_out, status, room_id, pre_reopen_actual_out')
    .eq('branch_id', branchId)
    .lt('check_in_date', upperBoundExclusive)
    .gte('check_in_date', addDays(monthStart, -366))
  const internalIds = (internalRooms || []).map(r => r.id)
  if (internalIds.length) q = q.not('room_id', 'in', `(${internalIds.join(',')})`)
  const { data, error } = await q
  if (error) throw error

  return (data || []).reduce(
    (total, st) => total + nightsInWindow(st, monthStart, upperBoundExclusive, today), 0)
}

// ---------- Corrections: Reception (live guests) ----------
// Live = anyone currently in-house or booked in, i.e. exactly the
// stays that still have a folio someone could need corrected.
// Deliberately NOT read from v_occupancy_today: that view is keyed on
// rooms and would hide a second stay sharing a room, and it omits the
// rate/cycle fields the correction sheet has to pre-fill.
export async function loadLiveStays(branchId) {
  const { data, error } = await supabase.from('stays')
    .select(`id, status, check_in_date, scheduled_out, checked_in_at, daily_rate, billing_cycle,
             guest_id, rooms(room_number, is_internal), guests!guest_id(id, full_name, phone)`)
    .eq('branch_id', branchId).in('status', ['occupied', 'reserved'])
    .order('check_in_date', { ascending: false })
  if (error) throw error
  return data || []
}

// A misspelled name belongs to the GUEST record, not the stay, so it
// is corrected once here and every past and future stay for that
// person shows the fix — renaming per-stay would fork their history.
export async function updateGuestIdentity(guestId, { fullName, phone }) {
  const patch = { full_name: fullName }
  if (phone !== undefined) patch.phone = phone || null
  const { error } = await supabase.from('guests').update(patch).eq('id', guestId)
  if (error) throw error
}

// Correcting a check-in date is exactly what this page exists for, so
// unlike updateStayDetails (which never touches it) this one can move
// it. The stays_no_date_overlap exclusion constraint still guards the
// room, so a correction that would double-book comes back as a
// database error rather than silently corrupting the board.
// Correcting a stay's dates and arrival time (568/569).
//
// This replaced a bare UPDATE on stays. The Reception tab told the clerk
// "Moving the dates is checked against the room's other bookings — if it
// would clash, the save is refused and nothing changes." Nothing checked
// anything: there was no overlap trigger on the table and the update
// went straight through. The screen had been promising a guard it did
// not have, which is worse than having none — a clerk told the app will
// catch a clash stops looking for one.
//
// correct_check_in does the checking, refuses without a reason, and
// returns what the move does to the nights and the bill. Call it with
// preview: true first and nothing is written.
export async function correctStay({ stayId, checkIn, scheduledOut, time, reason, preview = false }) {
  const { data, error } = await supabase.rpc('correct_check_in', {
    p_stay: stayId,
    p_date: checkIn || null,
    p_out: scheduledOut || null,
    p_time: time || null,
    p_reason: reason || null,
    p_preview: !!preview,
  })
  if (error) throw error
  return data
}

// Duplicate guest candidates — see migration 229. Returns PAIRS with a
// reason ('same phone' / 'initials match' / 'similar name'); nothing
// is merged automatically, because a shared phone can legitimately
// mean two people in one family.
// "Not the same person" — two records that merely look alike (PSN [GROUP 1]
// and PSN [GROUP 10], two brothers sharing a phone). The pair is remembered as
// checked and the finder stops offering it; nothing about either record changes.
export async function dismissDuplicatePair(kind, a, b) {
  const { error } = await supabase.rpc('dismiss_duplicate_pair', { p_kind: kind, p_a: a, p_b: b })
  if (error) throw error
}

export async function findDuplicateGuests(branchId) {
  const { data, error } = await supabase.rpc('find_duplicate_guests', { p_branch: branchId })
  if (error) throw error
  return data || []
}

// Counts THIS person submitted that have since been verified — the
// mirror of loadPendingVerifications, which tells verifiers what is
// waiting for them. Returns the newest verified_at so the caller can
// tell "something new" from "same as last time"; a plain count cannot,
// because verifying one count while an older one scrolls out of the
// window leaves the total unchanged.
export async function loadMyVerifiedCounts(staffId, sinceIso) {
  let q = supabase.from('stock_counts')
    .select('id, verified_at, location_id, count_date, verifier:verified_by(full_name)')
    .eq('counted_by', staffId).eq('status', 'verified')
    .order('verified_at', { ascending: false }).limit(20)
  if (sinceIso) q = q.gt('verified_at', sinceIso)
  const { data, error } = await q
  if (error) return { rows: [], newest: null }
  const rows = data || []
  return { rows, newest: rows[0]?.verified_at || null }
}

// Duplicate CREDIT CUSTOMER candidates — the per-department credit
// accounts, distinct from guests. Returns pairs with each side's
// balance and which departments it is used at, because the name alone
// is not enough to decide which record to keep.
export async function findDuplicateCustomers(branchId) {
  const { data, error } = await supabase.rpc('find_duplicate_customers', { p_branch: branchId })
  if (error) throw error
  return data || []
}

// All active credit accounts in a branch with what each owes, for the
// manual merge picker (pairs the finder cannot detect).
export async function loadCustomerAccountsForMerge(branchId) {
  const { data: custs, error } = await supabase.from('customers')
    .select('id, name').eq('branch_id', branchId).eq('is_active', true).order('name')
  if (error) throw error
  const { data: bals } = await supabase.from('v_customer_balances_by_staff')
    .select('customer_id, balance').eq('branch_id', branchId)
  const owed = new Map()
  for (const b of bals || []) owed.set(b.customer_id, (owed.get(b.customer_id) || 0) + Number(b.balance || 0))
  return (custs || []).map(c => ({ ...c, balance: owed.get(c.id) || 0 }))
}

export async function mergeCustomers(survivorId, duplicateIds) {
  // Parameter names are p_keep / p_merge — the signature that already
  // existed in the database. Kept rather than renamed so anything else
  // calling this RPC continues to work.
  const { error } = await supabase.rpc('merge_customers', {
    p_keep: survivorId, p_merge: duplicateIds,
  })
  if (error) throw error
}

// Department credit accounts not attached to any guest. These are the
// balances that go missing at checkout: the front desk settles the
// room, and money sitting on a named account at a bar or the minimart
// is never surfaced because nothing ties it to the guest.
export async function loadUnlinkedCustomerBalances(branchId) {
  const { data: custs, error } = await supabase.from('customers')
    .select('id, name, phone')
    .eq('branch_id', branchId).eq('is_active', true).is('linked_guest_id', null)
  if (error) throw error
  if (!custs?.length) return []

  const { data: bals } = await supabase.from('v_customer_balances_by_staff')
    .select('customer_id, location_id, balance')
    .in('customer_id', custs.map(c => c.id))

  const byId = {}
  for (const b of (bals || [])) {
    const e = byId[b.customer_id] || (byId[b.customer_id] = { total: 0, locs: new Set() })
    e.total += Number(b.balance)
    if (Number(b.balance) > 0.009) e.locs.add(b.location_id)
  }
  // Only those actually owing — a zero account needs no attention.
  return custs
    .map(c => ({ ...c, balance: byId[c.id]?.total || 0,
                 locationIds: [...(byId[c.id]?.locs || [])] }))
    .filter(c => c.balance > 0.009)
    .sort((a, b) => b.balance - a.balance)
}


// Credit activity on ONE day — both credit taken and repayments made,
// as a single ordered list. Rows carry a `kind` ('taken' | 'repaid')
// so the UI can show repayments as negative without a second query.
//
// Only the credit PORTION of a sale counts: a split sale (part cash,
// part credit) raises only what actually went on credit, and using the
// full sale value would overstate the day.
export async function loadCreditOnDate(branchId, date, locationId) {
  let sq = supabase.from('sales')
    .select(`id, qty, location_id, description, customer_id,
             stock_items(name), customers(name), staff:recorded_by(full_name),
             sale_payments(method, amount)`)
    .eq('branch_id', branchId).eq('business_date', date)
    .not('customer_id', 'is', null)
  if (locationId) sq = sq.eq('location_id', locationId)

  let rq = supabase.from('credit_repayments')
    .select(`id, amount, location_id, customer_id, method,
             customers(name), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('paid_on', date)
  if (locationId) rq = rq.eq('location_id', locationId)

  const [{ data: sales, error: e1 }, { data: reps, error: e2 }] =
    await Promise.all([sq, rq])
  if (e1) throw e1
  if (e2) throw e2

  const taken = (sales || []).map(s => {
    const amount = (s.sale_payments || [])
      .filter(p => p.method === 'credit')
      .reduce((t, p) => t + Number(p.amount), 0)
    return {
      kind: 'taken', id: s.id, amount,
      customer: s.customers?.name || 'Unknown',
      item: s.stock_items?.name || s.description || 'Item',
      qty: Number(s.qty), location_id: s.location_id,
      who: s.staff?.full_name ? `by ${s.staff.full_name}` : '',
    }
  }).filter(r => r.amount > 0.009)

  const repaid = (reps || []).map(r => ({
    kind: 'repaid', id: r.id, amount: Number(r.amount),
    customer: r.customers?.name || 'Unknown',
    item: 'Repayment', qty: null, location_id: r.location_id,
    who: r.staff?.full_name ? `to ${r.staff.full_name}` : '',
  }))

  return {
    takenTotal: taken.reduce((t, r) => t + r.amount, 0),
    repaidTotal: repaid.reduce((t, r) => t + r.amount, 0),
    rows: [...taken, ...repaid].sort((a, b) => b.amount - a.amount),
  }
}

// PR and DAMAGE for one day, ITEMISED and valued at cost — kept apart,
// because they are different things. PR is a decision someone made;
// damage is a loss, and a large one needs checking against the broken
// bottles. A single "Damaged 6 units · ₦22,000" line says neither what
// was damaged nor why.
//
// Three paths produce both, in different tables:
//   1. writeoffs     -> stock_movements 'complimentary' / 'damage',
//                       which carry unit_cost on the row, so the cost is
//                       exact rather than looked up against a price that
//                       may have changed since
//   2. till entries  -> sales with order_type 'pr_damage'. damage_reason
//                       tells them apart: set = damage, empty = PR only
//                       (that is exactly what the till asks). Costed from
//                       the unit_cost stamped on the row when it was
//                       recorded, the same as path 1
//   3. restaurant    -> order_items with order_type 'pr_damage'. Food is
//                       not stock-tracked and the ingredients were
//                       expensed when bought, so there is NO cost for
//                       these; reported separately at menu value rather
//                       than guessed at
export async function loadWriteoffsOnDate(branchId, date, locationId) {
  const loc = locationId && locationId !== 'all' ? locationId : null

  // recorded_by is read as a plain id and the names looked up after —
  // every other stock_movements query in this file does the same. Asking
  // PostgREST to embed staff here made the whole query fail, which hid
  // the section on the dashboard with no error shown.
  let mq = supabase.from('stock_movements')
    .select(`qty, unit_cost, movement_type, damage_reason, note, from_location,
             recorded_by, stock_items(name)`)
    .eq('branch_id', branchId).eq('business_date', date)
    .in('movement_type', ['complimentary', 'damage'])
  if (loc) mq = mq.eq('from_location', loc)

  let sq = supabase.from('sales')
    .select(`qty, location_id, description, damage_reason, writeoff_note, no_stock_declared,
             unit_cost, stock_items(name, cost_price), staff:recorded_by(full_name)`)
    .eq('branch_id', branchId).eq('business_date', date)
    .eq('order_type', 'pr_damage')
  if (loc) sq = sq.eq('location_id', loc)

  const [{ data: moves }, { data: prSales }, { data: orders }] = await Promise.all([
    mq, sq,
    supabase.from('orders')
      .select(`id, order_items(description, qty, amount, order_type, pr_meal,
               damage_reason, writeoff_note, no_stock_declared)`)
      .eq('branch_id', branchId).eq('business_date', date),
  ])

  // One lookup for the handful of people involved.
  const ids = [...new Set((moves || []).map(m => m.recorded_by).filter(Boolean))]
  const names = {}
  if (ids.length) {
    const { data: ppl } = await supabase.from('staff').select('id, full_name').in('id', ids)
    for (const x of (ppl || [])) names[x.id] = x.full_name
  }

  const pr = [], damage = []
  for (const m of (moves || [])) {
    const line = {
      name: m.stock_items?.name || 'Item', qty: Number(m.qty),
      cost: Number(m.qty) * Number(m.unit_cost || 0),
      reason: m.damage_reason || null, note: m.note || null,
      who: names[m.recorded_by] || '', locationId: m.from_location,
    }
    ;(m.movement_type === 'damage' ? damage : pr).push(line)
  }
  for (const s of (prSales || [])) {
    const line = {
      name: s.stock_items?.name || s.description || 'Item', qty: Number(s.qty),
      // The cost stamped on the row when it happened. Only an older row
      // with nothing stamped falls back to today's cost price — a cost
      // price changed next month must not rewrite this month's loss.
      cost: Number(s.qty) * Number(s.unit_cost ?? s.stock_items?.cost_price ?? 0),
      reason: s.damage_reason || null, note: s.writeoff_note || null,
      who: s.staff?.full_name || '', locationId: s.location_id,
      noStock: !!s.no_stock_declared,
    }
    // The till's own question: a reason set means damage, none means PR.
    ;(s.damage_reason ? damage : pr).push(line)
  }

  // Restaurant meals: menu value only, no cost available.
  const food = []
  for (const o of (orders || [])) {
    for (const li of (o.order_items || [])) {
      if (li.order_type !== 'pr_damage') continue
      food.push({
        name: li.description || 'Meal', qty: Number(li.qty),
        value: Number(li.amount || 0), meal: li.pr_meal,
        reason: li.damage_reason || null, note: li.writeoff_note || null,
        noStock: !!li.no_stock_declared,
      })
    }
  }

  const sum = rows => rows.reduce((t, r) => t + r.cost, 0)
  const byValue = (a, b) => b.cost - a.cost
  return {
    pr: pr.sort(byValue), damage: damage.sort(byValue),
    prCost: sum(pr), damageCost: sum(damage),
    food, foodValue: food.reduce((t, r) => t + r.value, 0),
  }
}

// ---------- Guest credit at the till ----------

// A whole till basket charged to a guest's room, as ONE order with one
// line per item. chargeItemToRoom writes an order per item, which suits
// the separate room-charge sheet but would split a five-drink round into
// five orders on the folio.
//
// Stock still deducts: order_items with a stock_item_id and location_id
// fire trg_order_item_stock_movement (migration 108b). Typed lines with
// no catalogue item deduct nothing — the same rule as everywhere else.
async function _chargeBasketToRoom({ staff, stayId, lines, locationId, date, locById }) {
  const nameOf = (locId) => locById?.[locId]?.name || ''
  // Guarded before anything is written, so a bad department cannot leave
  // half a basket behind.
  for (const l of lines) assertSellingDept(nameOf(l.locationId || locationId))
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    branch_id: staff.branch_id, stay_id: stayId, business_date: date,
    settlement: 'charged_to_room', served_by: staff.id, occurred_at: new Date().toISOString(),
  }).select('id').single()
  if (oErr) throw oErr

  const rows = lines.map(l => {
    const loc = l.locationId || locationId
    return {
      order_id: order.id,
      category: chargeCategoryFor(nameOf(loc)),
      stock_item_id: l.item?.id || null,
      // Typed lines carry their department too now; no stock item means
      // the stock trigger still returns early. See _chargeItemToRoom.
      location_id: loc || null,
      description: l.item ? l.item.name : (l.description || 'Item'),
      qty: l.qty, unit_price: l.unitPrice,
      order_type: l.orderType === 'staff' ? 'staff' : 'standard',
      writeoff_note: l.writeoffNote || null,
    }
  })
  // Insert with the ids back, so the stock used with a typed order can be
  // attached to its own line below.
  const { data: saved, error: iErr } = await supabase.from('order_items').insert(rows).select('id')
  if (iErr) {
    // Never leave an empty order on the folio.
    await supabase.from('orders').delete().eq('id', order.id)
    throw iErr
  }

  // Stock used with a typed restaurant order (water, extra chicken ...).
  // A basket paid at the counter has always recorded this; charged to a room
  // it was dropped silently, so the plate reached the guest's bill while the
  // ingredients stayed on Restaurant's stock. Done after the charge is safely
  // saved, and a failure here says so rather than losing the charge.
  const withStock = lines
    .map((l, i) => ({ used: l.stockUsed, id: saved?.[i]?.id }))
    .filter(x => x.used?.length && x.id)
  for (const x of withStock) {
    try { await recordOrderItemStockUsed(x.id, x.used) }
    catch (e) { throw partialStockError(e) }
  }

  // The approval trigger (249) runs after the items land, so this read
  // reflects whether the charge went straight on or is waiting.
  const { data: after } = await supabase.from('orders')
    .select('approval_status').eq('id', order.id).single()
  return { orderId: order.id, status: after?.approval_status || 'approved' }
}


// The guest's own bar tab: a customer account LINKED to them, so it
// shows on their folio at checkout while being billed separately (e.g.
// for company expenses). Reuses a tab already linked to this guest if
// there is one, so repeat visits don't create repeat accounts.
export async function getOrCreateGuestTab(branchId, guest) {
  const { data: linked } = await supabase.from('customers')
    .select('id, name, served_by')
    .eq('branch_id', branchId).eq('linked_guest_id', guest.id).eq('is_active', true)
    .limit(1).maybeSingle()
  if (linked) return linked

  const c = await createCustomer(branchId, guest.full_name)
  // createCustomer returns an EXISTING account on a name clash. Only
  // claim it if it isn't already attached to a different guest —
  // otherwise two people sharing a name would share a tab.
  const { data: row } = await supabase.from('customers')
    .select('linked_guest_id').eq('id', c.id).single()
  if (row?.linked_guest_id && row.linked_guest_id !== guest.id) {
    throw new Error(`"${guest.full_name}" already has a tab linked to another guest. Use the customer list to pick the right one.`)
  }
  if (!row?.linked_guest_id) await linkCustomerToGuest(c.id, guest.id)
  return c
}

// ---------- Room charge approvals (Phase 2) ----------

// Room charges in one approval state, with who served them and for which
// room — enough to decide without opening the folio.
export async function loadRoomChargesByStatus(branchId, status) {
  const { data, error } = await supabase.from('orders')
    .select(`id, business_date, created_at, approval_status, decision_note, served_by,
             served:served_by(full_name),
             stays(id, rooms(room_number), guests!guest_id(full_name)),
             order_items(id, description, qty, unit_price, amount, order_type, location_id)`)
    .eq('branch_id', branchId).eq('settlement', 'charged_to_room')
    .eq('approval_status', status)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map(o => {
    const items = o.order_items || []
    return {
      id: o.id, date: o.business_date, createdAt: o.created_at, note: o.decision_note,
      servedBy: o.served?.full_name || '', servedById: o.served_by,
      room: o.stays?.rooms?.room_number, guest: o.stays?.guests?.full_name,
      items,
      // Billable only — PR/damage is never charged, so never collected.
      total: items.filter(i => i.order_type !== 'pr_damage')
                  .reduce((t, i) => t + Number(i.amount || 0), 0),
    }
  })
}

async function _approveRoomCharge(orderId, note) {
  const { error } = await supabase.rpc('approve_room_charge', { p_order: orderId, p_note: note || null })
  if (error) throw error
}

async function _rejectRoomCharge(orderId, note) {
  const { error } = await supabase.rpc('reject_room_charge', { p_order: orderId, p_note: note })
  if (error) throw error
}

// Settle a refused charge at the bar. One database transaction creates
// the sale and releases the room-charge stock, so each bottle is
// deducted exactly once. Returns the receipt id.
export async function collectRejectedRoomCharge({ orderId, payments, customerId, locationId }) {
  const { data, error } = await supabase.rpc('collect_rejected_room_charge', {
    p_order: orderId, p_payments: payments,
    p_customer: customerId || null, p_location: locationId || null,
  })
  if (error) throw error
  return data
}

// What became of specific room charges — used to tell a bartender the
// outcome once a charge he was waiting on leaves the pending list.
export async function loadOrderOutcomes(ids) {
  if (!ids?.length) return []
  const { data, error } = await supabase.from('orders')
    .select('id, approval_status, decision_note, stays(rooms(room_number))')
    .in('id', ids)
  if (error) return []
  return (data || []).map(o => ({
    id: o.id, status: o.approval_status, note: o.decision_note,
    room: o.stays?.rooms?.room_number,
  }))
}

// What each customer owed AT THE END of a given day. Mirrors
// v_customer_balances_by_staff exactly, with a date cut-off (migration
// 271), so it reconciles with the current balance instead of drifting.
//
// This is what the books NOW say about that day — not a snapshot of
// what the screen showed on the night. Backdated entries, date
// corrections and later edits all change a past day after the fact,
// which is precisely why the two figures are shown side by side.
export async function loadBalancesAsAt(branchId, asAt, locationId) {
  const { data, error } = await supabase.rpc('customer_balances_as_at', {
    p_branch: branchId, p_as_at: asAt,
    p_location: locationId && locationId !== 'all' ? locationId : null,
  })
  if (error) throw error
  return data || []
}

// Existing customers close to a name being typed — same name written
// differently, words reordered, or a letter out (migration 282).
// Checked BEFORE creating, so the person sees the record they already
// have instead of making a second one.
export async function findSimilarCustomers(branchId, name) {
  if (!name || name.trim().length < 2) return []
  const { data, error } = await supabase.rpc('find_similar_customers', {
    p_branch: branchId, p_name: name.trim(),
  })
  if (error) return []        // never block a sale on the warning failing
  return data || []
}

// ---------- Staff accounts (GM/admin) ----------

// Active staff at this branch, with their login email and when it was
// last used — enough to see whether an account is still in use before
// handing it to someone else.
export async function loadStaffAccounts(branchId) {
  const { data, error } = await supabase.from('staff')
    .select('id, full_name, role, is_active, note')
    .eq('branch_id', branchId).eq('is_active', true)
    .order('role').order('full_name')
  if (error) throw error
  return data || []
}

// Logins that can be linked to a payroll record in this branch: this
// branch's own accounts PLUS GM/admin accounts from any branch, because the
// GM works in both and is paid separately by each.
export async function loadLoginsForPayroll(branchId) {
  const { data, error } = await supabase.from('staff')
    .select('id, full_name, role, branch_id, is_active')
    .eq('is_active', true)
    .or(`branch_id.eq.${branchId},role.in.(gm,admin)`)
    .order('role').order('full_name')
  if (error) throw error
  return data || []
}

// Hand an account to someone else: new password, and a dated note of who
// holds it now. Runs on the server (reset-staff-password), because
// changing another person's password needs a key that must never be in
// a phone app.
export async function resetStaffPassword(staffId, newPassword, newHolderName) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reset-staff-password`,
    { method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ staffId, newPassword, newHolderName }) })
  const out = await res.json().catch(() => ({ ok: false, error: 'No response from the server' }))
  if (!out.ok) throw new Error(out.error || 'Could not reset the password')
  return out
}

// A leaver on a PERSONAL login is deactivated, not reset: sign-in
// requires is_active, so this locks them out immediately whatever their
// password is, and every database rule checks it too.
export async function deactivateStaff(staffId) {
  const { error } = await supabase.rpc('deactivate_staff', { p_staff: staffId })
  if (error) throw error
  // Read it back: a switch-off that quietly changed nothing used to be
  // reported as done.
  const { data } = await supabase.from('staff').select('is_active').eq('id', staffId).maybeSingle()
  if (data && data.is_active) throw new Error('The account is still active - the switch-off did not apply.')
}

// Correct the date of a room charge (migration 292). GM/admin only, and
// the database enforces that too.
//
// business_date sits on the ORDER, not the item, so if other charges
// share that order the function moves THIS item onto its own order and
// leaves the rest alone — otherwise a guest's drinks would travel with
// their meal. The guest's balance is checked before and after: only the
// day may change.
export async function moveRoomChargeDate(orderItemId, newDate) {
  const { error } = await supabase.rpc('move_room_charge_date', {
    p_item: orderItemId, p_date: newDate,
  })
  if (error) throw error
}

// A month's credit per customer: what they owed at the start, took,
// repaid, and owe at the end (migration 294). This is the monthly staff
// credit analysis that sets payroll deductions.
//
// Room charges cannot appear here — they are orders on a folio, never
// sales with a credit payment (verified in 293).
export async function loadCreditForMonth(branchId, year, month, locationId) {
  const { data, error } = await supabase.rpc('customer_credit_for_month', {
    p_branch: branchId, p_year: year, p_month: month,
    p_location: locationId && locationId !== 'all' ? locationId : null,
  })
  if (error) throw error
  return data || []
}


// Takes back a sale just recorded (by the same person, within 10 minutes).
// One database step; the database enforces who and when.
export async function undoRecentReceipt(receiptId) {
  const { data, error } = await supabase.rpc('undo_recent_receipt', { p_receipt: receiptId })
  if (error) throw error
  if (!data) throw new Error('Nothing was undone — it may be older than 10 minutes.')
}


// Keeps the result of "Match your Total Sales" so managers can see who closes clean.
// Never blocks the person: a failure here is silent.
async function _recordTillCheck({ branchId, locationId, date, appPos, appCash, pos, cash }) {
  const { error } = await supabase.rpc('record_till_check', {
    p_branch: branchId, p_location: locationId, p_date: date,
    p_app_pos: appPos, p_app_cash: appCash, p_pos: pos, p_cash: cash })
  if (error) throw error
}

// How steadily each person is doing the Total Sales check (migration
// 470). Counts the check being DONE, never the figures agreeing — see
// MyWeek.jsx for why that distinction must not be reversed.
export async function loadMyWeek(branchId, days = 7) {
  const { data, error } = await supabase.rpc('my_week', { p_branch: branchId, p_days: days })
  if (error) throw error
  return data || { me: [], team: [] }
}

// Has this till been counted for this day? Any count by anyone at that
// department counts — the question is whether the day was reconciled,
// not who typed it. Used to unlock the POS/Cash/Credit tile, which
// stays covered until the person has committed to their own figure.
//
// Asked through a function, not by reading till_checks directly
// (migration 527). till_checks has row security on and no read policy,
// so a plain select returns nothing to everyone — including the person
// who has just counted. Counts still SAVED, because saving goes
// through record_till_check, which runs with the database's own
// rights; only reading was blocked, so the tile never uncovered for
// anybody on any day and a deliberate lock looked like a fault.
//
// Throws on failure instead of answering false. A denied read and an
// uncounted till are not the same thing, and reporting one as the
// other is exactly how this hid for as long as it did.
export async function tillCheckDone(branchId, locationId, date) {
  if (!branchId || !locationId || !date) return false
  const { data, error } = await supabase.rpc('till_check_done',
    { p_branch: branchId, p_location: locationId, p_date: date })
  if (error) throw error
  return !!data
}

export async function loadTillChecks(branchId, days = 14) {
  const { data, error } = await supabase.rpc('till_checks_report', { p_branch: branchId, p_days: days })
  if (error) throw error
  return { checks: data?.checks || [], missing: data?.missing || [] }
}


// The signed-in person's OWN finalised pay months (empty unless GM/admin has
// linked their login to a payroll employee). The database decides what is returned.
// The signed-in person's OWN staff credit — what they have taken this
// month and what is still to come off their pay (migration 477). Reads
// the same customer account payroll deducts from, so the page and the
// deduction can never disagree. Returns no pay projection on purpose:
// contributions, pot and savings are only settled at month end.
export async function loadMyCredit(branchId = null) {
  const { data, error } = await supabase.rpc('my_credit', { p_branch: branchId })
  if (error) throw error
  return data || { linked: false }
}

export async function loadMyPay() {
  const { data, error } = await supabase.rpc('my_pay')
  if (error) throw error
  return data || { linked: false, months: [] }
}


// Current employees whose name matches ANOTHER credit account that is not
// the payroll-linked one (e.g. "Auditor chioma" next to "Chioma (staff)").
// GM/admin only; any failure is treated as "none found" by the caller.
export async function loadPossibleDuplicateAccounts(branchId) {
  const { data, error } = await supabase.rpc('payroll_possible_duplicate_accounts', { p_branch: branchId })
  if (error) throw error
  return data || []
}

// ---------- Shift handover notes ----------
export async function loadHandoverNotes(branchId, locationId) {
  const { data, error } = await supabase.rpc('list_handover_notes', { p_branch: branchId, p_location: locationId })
  if (error) throw error
  return data || []
}
export async function addHandoverNote(branchId, locationId, body) {
  const { error } = await supabase.rpc('add_handover_note', { p_branch: branchId, p_location: locationId, p_body: body })
  if (error) throw error
}
export async function ackHandoverNote(id) {
  const { error } = await supabase.rpc('ack_handover_note', { p_note: id })
  if (error) throw error
}


// Saves that are logged to the GM's Staff activity screen (see lib/activity.js).
export const saveBasket = tracked('Recorded a sale', _saveBasket)
export const saveWriteoff = tracked('Recorded a write-off / PR / staff item', _saveWriteoff)
export const saveRestaurantWriteoff = tracked('Recorded a restaurant write-off', _saveRestaurantWriteoff)
export const saveRepayment = tracked('Recorded a credit repayment', _saveRepayment)
export const submitCount = tracked('Submitted a stock count', _submitCount)
export const verifyCount = tracked('Verified a stock count', _verifyCount)
export const saveMovements = tracked('Recorded a stock movement', _saveMovements)
export const chargeItemToRoom = tracked('Charged an item to a room', _chargeItemToRoom)
export const chargeBasketToRoom = tracked('Charged items to a room', _chargeBasketToRoom)
export const chargeWriteoffToRoom = tracked('Charged a PR/staff order to a room', _chargeWriteoffToRoom)
export const recordStayPayment = tracked('Recorded a room payment', _recordStayPayment)
export const recordDepartmentReceipt = tracked('Recorded money received from the front desk', _recordDepartmentReceipt)
export const checkOutStay = tracked('Checked a guest out', _checkOutStay)
export const recordTillCheck = tracked('Entered Total Sales at close', _recordTillCheck)
export const approveRoomCharge = tracked('Approved a room charge', _approveRoomCharge)
export const rejectRoomCharge = tracked('Refused a room charge', _rejectRoomCharge)
export const deleteEntry = tracked('Deleted an entry', _deleteEntry)
export const deleteStay = tracked('Deleted a stay', _deleteStay)
export const deleteRoomPayment = tracked('Deleted a room payment', _deleteRoomPayment)
export const updateRoomPayment = tracked('Corrected a room payment', _updateRoomPayment)

// One payment that was really two (Chris, 25 October 2026).
//
// A guest pays part on the card and part in cash and it gets keyed as a
// single line. Correcting the method does not help: whichever one you
// pick, one till is over and the other is short by the same amount.
//
// So the original row keeps the POS part and a second row carries the
// cash. The guest's total is unchanged — that is checked here, not
// trusted — and each part lands on the till that actually has it.
//
// Both rows carry a remark naming the other. The audit trail logs the
// UPDATE to the original but not the INSERT of the new row
// (log_room_payment_change is AFTER DELETE OR UPDATE), so without the
// remark the cash row would read as money that appeared from nowhere.
//
// Any amount or day the user also changed is applied in the SAME update,
// not a second one, so a half-finished correction cannot be left behind.
async function _splitRoomPayment(row, { pos, cash, total, businessDate }) {
  const p = Number(pos) || 0
  const c = Number(cash) || 0
  const t = Number(total)
  if (!(t > 0)) throw new Error('Enter what the guest paid altogether.')
  if (p < 0 || c < 0) throw new Error('An amount cannot be negative.')
  if (Math.abs((p + c) - t) > 0.009) {
    throw new Error('The card part and the cash part must add up to what the guest paid.')
  }
  const date = businessDate || row.business_date

  // Only one part after all: there is nothing to split, so just correct
  // the one row rather than leaving a zero-naira payment on the books.
  if (p <= 0.009) { await _updateRoomPayment(row.id, { amount: c, method: 'cash', businessDate: date }); return }
  if (c <= 0.009) { await _updateRoomPayment(row.id, { amount: p, method: 'pos', businessDate: date }); return }

  const note = (txt) => [row.remark, txt].filter(Boolean).join(' · ')
  const { error: e1 } = await supabase.from('payments')
    .update({ method: 'pos', amount: p, business_date: date,
              remark: note('split: cash part recorded separately') })
    .eq('id', row.id)
  if (e1) throw e1

  const { error: e2 } = await supabase.from('payments').insert({
    stay_id: row.stay_id, branch_id: row.branch_id, business_date: date,
    method: 'cash', amount: c, received_by: row.received_by || null,
    is_overstay: row.is_overstay ?? false,
    remark: note('split: cash part of one payment'),
  })
  // The first half already went through. Say exactly where it stopped —
  // "it failed" would send someone looking for an unchanged row.
  if (e2) {
    throw new Error(`The card part was saved as ${p}, but the cash part of ${c} could not be added: ${e2.message}`)
  }
}
export const splitRoomPayment = tracked('Split a room payment', _splitRoomPayment)
export const deleteOrderItem = tracked('Deleted a room-charge item', _deleteOrderItem)
export const deleteCount = tracked('Deleted a stock count', _deleteCount)
export const deleteRepayment = tracked('Deleted a repayment', _deleteRepayment)

// GM / admin only (the database refuses anyone else).
export async function loadStaffActivity(branchId, days = 30) {
  const { data, error } = await supabase.rpc('staff_activity_report', { p_branch: branchId, p_days: days })
  if (error) throw error
  return data || []
}

// ---------- Attendance by location (migration 346), GM / admin only ----------
export async function loadAttendance(branchId, days = 14) {
  const { data, error } = await supabase.rpc('attendance_report', { p_branch: branchId, p_days: days })
  if (error) throw error
  return data || { geofence: { set: false }, people: [] }
}
export async function setBranchGeofence(branchId, lat, lng, radius = 150) {
  const { error } = await supabase.rpc('set_branch_geofence', { p_branch: branchId, p_lat: lat, p_lng: lng, p_radius: radius })
  if (error) throw error
}

// ---------- supplies used (salt, detergent, Knorr ...) — migration 382 ----------
// Takes the quantity off the department's stock and records who, when and
// WHY (the note is required, so the auditor always has something to ask about).
export async function recordSuppliesUse(locationId, lines, note, usedBy = null) {
  const { error } = await supabase.rpc('record_supplies_use', {
    p_location: locationId,
    p_lines: lines.map(l => ({ item: l.item.id, qty: Number(l.qty) })),
    p_note: note,
    p_used_by: usedBy,
  })
  if (error) throw error
}

// Supplies feed: what the Store handed to a department, what the department
// used, and what was undone. kind = 'received' | 'used' | 'undo'.
export async function loadSuppliesUse(branchId, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('stock_movements')
    .select(`id, movement_type, business_date, qty, note, received_by, created_at, recorded_by,
             from_location, to_location, stock_item_id, reverses_id,
             stock_items!inner(name, is_consumable), staff:recorded_by(full_name),
             from_loc:from_location(name, is_store), to_loc:to_location(name, is_store)`)
    .eq('branch_id', branchId)
    .in('movement_type', ['used', 'transfer', 'issue', 'adjustment'])
    .eq('stock_items.is_consumable', true).gte('business_date', since)
    .order('created_at', { ascending: false }).limit(2000)
  if (error) throw error
  const undone = new Set(data.filter(r => r.reverses_id).map(r => r.reverses_id))
  const rows = []
  for (const r of data) {
    if (r.movement_type === 'used') {
      rows.push({ ...r, kind: 'used', dept_id: r.from_location, dept_name: r.from_loc?.name, undone: undone.has(r.id) })
    } else if (r.movement_type === 'adjustment' && r.reverses_id) {
      rows.push({ ...r, kind: 'undo', dept_id: r.to_location, dept_name: r.to_loc?.name })
    } else if (['transfer', 'issue'].includes(r.movement_type) && r.from_loc?.is_store && r.to_loc && !r.to_loc.is_store) {
      rows.push({ ...r, kind: 'received', dept_id: r.to_location, dept_name: r.to_loc?.name })
    }
  }
  return rows
}

export async function voidSuppliesUse(movementId, reason) {
  const { error } = await supabase.rpc('void_supplies_use', { p_movement: movementId, p_reason: reason })
  if (error) throw error
}

// Which supplies each department may hold and use: { locationId: Set(itemId) }.
// A department with no entries is unrestricted.
export async function loadDepartmentSupplies(branchId) {
  const { data, error } = await supabase.from('supply_department_items')
    .select('location_id, stock_item_id, stock_locations!inner(branch_id)')
    .eq('stock_locations.branch_id', branchId)
  if (error) throw error
  const map = {}
  for (const r of data) (map[r.location_id] ||= new Set()).add(r.stock_item_id)
  return map
}

export async function setDepartmentSupply(locationId, itemId, on) {
  const { error } = await supabase.rpc('set_department_supply',
    { p_location: locationId, p_item: itemId, p_on: on })
  if (error) throw error
}

export async function returnSuppliesToStore(locationId, itemId, qty, reason) {
  const { error } = await supabase.rpc('return_supplies_to_store',
    { p_location: locationId, p_item: itemId, p_qty: qty, p_reason: reason })
  if (error) throw error
}
