import { useCallback, useEffect, useMemo, useState } from 'react'
import { lagosDaysAgo, lagosToday, methodLabel, naira, paymentSummary, startingDept, tierLabel, whoRecorded } from '../lib/format'
import { loadStockMap, loadPopular, loadToday, saveBasket, saveWriteoff,
         loadDailyFinancials, loadCustomers, createCustomer,
         loadOpeningDate, loadBalances, loadReceipt,
         loadStaffForLocation, loadReceptionActivity, loadReceptionDashboard, deleteEntry,
         loadRoomCharges, deleteOrderItem, saveRestaurantWriteoff, loadRoomsSoldInMonth,
         loadWriteoffsOnDate, loadLiveStays, chargeBasketToRoom,
         getOrCreateGuestTab, updateSaleWithPayments, undoRecentReceipt, recordTillCheck } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import { useToast } from '../components/Toast'
import ReceptionDashboard from '../components/ReceptionDashboard'
import WriteoffBreakdown from '../components/WriteoffBreakdown'
import RoomChargeApprovals from '../components/RoomChargeApprovals'
import CollectRefusedCharges from '../components/CollectRefusedCharges'
import MyPendingRoomCharges from '../components/MyPendingRoomCharges'
import ItemPicker from '../components/ItemPicker'
import RoomChargeSheet from '../components/RoomChargeSheet'
import CustomerPicker from '../components/CustomerPicker'
import Receipt from '../components/Receipt'
import MatchTill from '../components/MatchTill'
import { APPROVE_ROOM_CHARGES, EDITOR, MANAGEMENT, OVERSIGHT, SUPERVISOR, is } from '../lib/roles'

const niceDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })

export default function SalesEntry({ boot }) {
  const { staff, locations, allLocations, tiers, methods, items } = boot
  const approvalsOn = boot.roomChargeApprovalLimit != null
  const toast = useToast()
  // Manager/gm/admin reach this page via More's "Record a sale for
  // any department" — that phrase is the actual product intent, so
  // they need every department as an option, not just whatever their
  // own staff_locations row happens to include (which may be none,
  // since oversight roles aren't normally tied to one department).
  // Bar/front_desk/storekeeper, who use this as their direct working
  // tab, stay scoped to their own assigned department(s) as before.
  // OVERSIGHT, matching Credit and Recovery, so the name means the same
  // thing on every page. NOTE: on THIS page department chips decide
  // where a sale is RECORDED, so this also lets store managers ring up
  // sales at any department — not only view them. Auditors cannot reach
  // this page, so for them nothing changes.
  const seesAllDepartments = is(staff.role, OVERSIGHT)
  const salesPoints = (seesAllDepartments ? allLocations : locations).filter(l => l.is_sales_point && !l.is_store)
  // anyone who records a sale may date it; overriding an unbalanced
  // sale stays with the roles above bar staff
  const canBackdate = staff.role !== 'auditor'
  const canOverrideVariance = is(staff.role, EDITOR)
  // Specifically excluded from on-behalf-of, per policy — pinned to
  // their staff id so a role change doesn't quietly reopen it, and
  // Nnewi's storekeeper (or any future Awka one) is unaffected. The
  // database enforces the same block; this only hides the picker so
  // they never see a control that would fail server-side.
  const NO_ON_BEHALF = new Set(['a5ea88b6-80e7-4776-a491-78a509e589c6'])
  const canRecordOnBehalf = canOverrideVariance && !NO_ON_BEHALF.has(staff.id)
  // bar staff can reach back 4 days; editors go to the opening balance
  // Must match window_days in validate_sale_date (migration 284).
  // If these drift, staff are offered dates the database refuses.
  const STAFF_BACKDATE_DAYS = 7
  const todayDate = lagosToday()
  const [date, setDate] = useState(todayDate)
  const [openingDate, setOpeningDate] = useState(null)
  const earliestDate = (() => {
    if (canOverrideVariance) return openingDate || undefined
    // count back from the Lagos business date so the boundary does not
    // shift with the device's timezone
    const d = new Date(todayDate + 'T12:00:00')
    d.setDate(d.getDate() - STAFF_BACKDATE_DAYS)
    const floor = d.toISOString().slice(0, 10)
    return openingDate && openingDate > floor ? openingDate : floor
  })()
  const [backdateReason, setBackdateReason] = useState('')

  const [locationId, setLocationId] = useState(startingDept(salesPoints, staff, locations))
  // SEEING a department and RECORDING at it are separate. Store managers
  // and auditors may select any department to view it (OVERSIGHT, above),
  // but may only record at departments they are assigned to. Manager, gm
  // and admin keep recording anywhere, exactly as before.
  const ownLocationIds = new Set((locations || []).map(l => l.id))
  const canRecordAt = (id) => is(staff.role, MANAGEMENT) || ownLocationIds.has(id)
  const canRecordHere = canRecordAt(locationId)
  // Mirrors moves_write after 283: anyone who can record, except an
  // auditor. Deliberately NOT canOverrideVariance, which also governs
  // backdating and variance overrides — different powers.
  const canWriteOff = staff.role !== 'auditor' && canRecordHere
  const canApprove = is(staff.role, APPROVE_ROOM_CHARGES)
  // Restaurant and Reception don't behave like a normal sales
  // department — Restaurant is typed-order-only (no catalog stock to
  // sell), Reception doesn't record sales at all (check-in/checkout/
  // folio work lives on the Rooms tab instead). Computed once here so
  // every button below agrees on it, rather than three separate
  // checks that could drift apart.
  const currentDept = salesPoints.find(l => l.id === locationId)
  const isRestaurant = /restaurant/i.test(currentDept?.name || '')
  const isReception = /reception/i.test(currentDept?.name || '')
  // Which order_items.category a room charge from THIS department
  // lands under — null for Reception, which has no charges of its
  // own. Any department can have items charged to a room, not just
  // Restaurant, so this drives loading and merging generically
  // rather than special-casing one department.
  const roomChargeCategory = isReception ? null
    : isRestaurant ? 'food'
    : /minimart/i.test(currentDept?.name || '') ? 'minimart'
    : 'drink'
  // Re-sync selected department on branch switch (GM) — otherwise the
  // old branch's location id stays selected, matching no chip here,
  // so nothing highlights until a manual tap.
  useEffect(() => {
    const valid = salesPoints.some(l => l.id === locationId)
    if (!valid) setLocationId(startingDept(salesPoints, staff, locations))
  }, [staff.branch_id])
  const [stockMap, setStockMap] = useState({})
  const [popular, setPopular] = useState({})
  const [today, setToday] = useState([])
  const [roomCharges, setRoomCharges] = useState([])   // Restaurant only: food charged to rooms
  const [receptionActivity, setReceptionActivity] = useState([])
  const [receptionDashboard, setReceptionDashboard] = useState(null)
  const [lastReceiptAt, setLastReceiptAt] = useState(0)
  const [switchingId, setSwitchingId] = useState(null)
  const [roomsSold, setRoomsSold] = useState(null)
  const [writeoffs, setWriteoffs] = useState(null)
  // In-house guests offered at the credit step, so a guest's drinks go
  // to their room or their own linked tab instead of a free-floating
  // customer account named after the room.
  const [inHouse, setInHouse] = useState([])
  const [guestChoice, setGuestChoice] = useState(null)  // stay awaiting room-vs-tab
  const [roomGuard, setRoomGuard] = useState(null)      // typed name that looks like a room
  // Internal rooms (GM Office, via rooms.is_internal) and the
  // monthly rooms-sold count are both
  // GM/admin-only visibility on the reception dashboard — matches
  // is_supervisor()'s own role set, not the broader oversight group.
  const isGmOrAdmin = is(staff.role, SUPERVISOR)
  const [showYesterday, setShowYesterday] = useState(false)
  const [yesterdaySummary, setYesterdaySummary] = useState(null)
  const [yesterdayActivity, setYesterdayActivity] = useState(null)
  // GM/Admin-only cleanup for training records, scoped specifically to
  // Restaurant here (Reception's version deletes a whole booking, not
  // a single row, so it lives separately in Folio)
  const canDeleteTraining = isRestaurant && is(staff.role, SUPERVISOR)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [writeoffBusy, setWriteoffBusy] = useState(false)

  async function doDeleteEntry() {
    setDeleteBusy(true)
    try {
      if (deleteConfirm.entryKind === 'roomCharge') {
        await deleteOrderItem(deleteConfirm.id, deleteConfirm.order_id)
      } else {
        await deleteEntry({ kind: 'sale', id: deleteConfirm.id })
      }
      toast('Deleted', 'success')
      setDeleteConfirm(null); refresh()
    } catch (e) { toast('Could not delete: ' + e.message, 'error') }
    setDeleteBusy(false)
  }
  const [summary, setSummary] = useState(null)
  const [recon, setRecon] = useState(null)
  const [customers, setCustomers] = useState([])

  const [basket, setBasket] = useState([])          // [{ key, item, tier, qty, unitPrice }]
  const [defaultTier, setDefaultTier] = useState('general')
  const [writeoffMode, setWriteoffMode] = useState(false)
  const [onBehalfOf, setOnBehalfOf] = useState(null)
  const [people, setPeople] = useState([])
  const [picking, setPicking] = useState(false)
  const [tuning, setTuning] = useState(null)        // line being adjusted
  const [paying, setPaying] = useState(null)        // payment step
  const [writeoff, setWriteoff] = useState(null)    // separate PR/damage flow
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState(null)
  const [lastReceiptId, setLastReceiptId] = useState(null)
  const [roomCharging, setRoomCharging] = useState(false)
  const [restaurantOrder, setRestaurantOrder] = useState(null)

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  // Restaurant food charged to a room never showed up here before —
  // it lives in orders/order_items, not sales, so it's merged in
  // specifically for this department rather than folded into
  // loadToday itself, which every other department still uses as-is.
  const combinedToday = useMemo(() => {
    const sales = today.map(r => ({ ...r, entryKind: 'sale', sortAt: r.created_at }))
    if (!roomChargeCategory) return sales
    const charges = roomCharges.map(r => ({
      ...r, entryKind: 'roomCharge', sortAt: r.orders?.created_at,
      roomNumber: r.orders?.stays?.rooms?.room_number, guestName: r.orders?.stays?.guests?.full_name,
    }))
    return [...sales, ...charges].sort((a, b) => (b.sortAt || '').localeCompare(a.sortAt || ''))
  }, [today, roomCharges, roomChargeCategory])
  const locById = useMemo(() =>
    Object.fromEntries((boot.allLocations || locations).map(l => [l.id, l])), [boot, locations])

  async function openReceipt(receiptId) {
    // PR, damage, staff meals and room charges are not paid sales, so
    // they have no receipt. Say so plainly instead of reporting it as an
    // error, which made staff think something had gone wrong.
    if (!receiptId) {
      toast('This entry has no receipt — it was not a paid sale', 'info')
      return
    }
    try { setReceipt(await loadReceipt(receiptId)) }
    catch (e) { toast(e.message, 'error') }
  }

  const refresh = useCallback(() => {
    loadStockMap(staff.branch_id).then(setStockMap).catch(() => {})
    loadPopular(staff.branch_id).then(setPopular).catch(() => {})
    loadToday(staff.branch_id, date, locationId).then(setToday).catch(() => {})
    if (isReception) {
      loadReceptionActivity(staff.branch_id, date).then(setReceptionActivity).catch(() => {})
      loadReceptionDashboard(staff.branch_id, date).then(setReceptionDashboard).catch(() => {})
      if (isGmOrAdmin) {
        loadRoomsSoldInMonth(staff.branch_id, date).then(setRoomsSold).catch(() => {})
      }
    }
    if (roomChargeCategory) {
      loadRoomCharges(staff.branch_id, date, roomChargeCategory).then(setRoomCharges).catch(() => {})
    }
    // On failure, record the error rather than silently showing nothing:
    // a hidden section looks identical to a day with no write-offs, which
    // is how a broken query went unnoticed.
    loadWriteoffsOnDate(staff.branch_id, date, locationId)
      .then(r => setWriteoffs({ ...r, error: null }))
      .catch(e => setWriteoffs({ pr: [], damage: [], food: [], prCost: 0, damageCost: 0,
                                 foodValue: 0, error: e.message || 'could not load' }))
    loadDailyFinancials(staff.branch_id, date, locationId).then(r => {
      setSummary({ byMethod: r.byMethod, nonRevenue: r.nonRevenue })
      setRecon({ grossSales: r.grossSales, received: r.received, creditRaised: r.creditRaised,
                 debtRecovered: r.debtRecovered, recoveredBy: r.recoveredBy, totalMoneyIn: r.totalMoneyIn,
                 unqualifiedCredit: r.unqualifiedCredit,
                 debtClearedByPayroll: r.debtClearedByPayroll, debtWrittenOff: r.debtWrittenOff })
    }).catch(() => {})
    loadOpeningDate(staff.branch_id).then(setOpeningDate).catch(() => {})

    if (canOverrideVariance) {
      loadStaffForLocation(staff.branch_id, locationId).then(ps => {
        setPeople(ps)
        // a person selected while looking at the previous bar may not
        // work this one — drop the selection rather than leave it stale
        setOnBehalfOf(cur => ps.some(p => p.id === cur) ? cur : null)
      })
    } else {
      setPeople([])
    }

    const wantsBalances = methods.includes('credit')
    Promise.all([
      loadCustomers(staff.branch_id),
      wantsBalances ? loadBalances(staff.branch_id, locationId).catch(() => []) : Promise.resolve([]),
    ])
      .then(([cs, bals]) => {
        const byId = Object.fromEntries(bals.map(b => [b.customer_id, Number(b.balance)]))
        setCustomers(cs.map(c => ({ ...c, balance: byId[c.id] || 0 })))
      })
      .catch(() => setCustomers([]))
  }, [staff.branch_id, date, locationId])

  // Lazy — only fetched when actually asked for, not on every load.
  useEffect(() => {
    if (!isReception || !showYesterday) return
    const y = lagosDaysAgo(1)
    loadDailyFinancials(staff.branch_id, y, locationId).then(setYesterdaySummary).catch(() => {})
    loadReceptionActivity(staff.branch_id, y).then(setYesterdayActivity).catch(() => {})
  }, [isReception, showYesterday, staff.branch_id, locationId])
  useEffect(refresh, [refresh])

  const priceFor = (item, tier) =>
    tier === 'lounge' ? Number(item.lounge_price ?? item.selling_price)
    : tier === 'staff' ? Number(item.staff_price ?? item.selling_price)
    : Number(item.selling_price)

  const onHand = (itemId, atLocationId) => stockMap[`${itemId}:${atLocationId || locationId}`] ?? 0
  const basketTotal = basket.reduce((s, l) => s + l.qty * l.unitPrice, 0)

  function addToBasket(item, sourceLocation) {
    setPicking(false)
    setBasket(b => {
      const at = b.findIndex(l => l.item?.id === item.id && l.tier === defaultTier
        && !l.priceOverridden && l.locationId === (sourceLocation?.id || undefined))
      if (at >= 0) {
        const copy = [...b]; copy[at] = { ...copy[at], qty: copy[at].qty + 1 }; return copy
      }
      return [...b, { key: crypto.randomUUID(), item, tier: defaultTier, qty: 1,
                      unitPrice: priceFor(item, defaultTier), priceOverridden: false,
                      // undefined for a normal same-department item (falls back to
                      // the basket's own locationId in saveBasket); set only for a
                      // cross-department pick like a Restaurant item sold at a bar
                      locationId: sourceLocation?.id, locationName: sourceLocation?.name }]
    })
  }

  // typed restaurant order — no catalog item, since a plate of food
  // isn't a countable stock unit the way a bottled drink is. Always
  // attributed to Restaurant's own daily figures regardless of which
  // bar rings it up, matching the earlier decision on how that
  // revenue should count.
  function addTypedOrder({ description, qty, unitPrice, orderType, writeoffNote }) {
    const restaurant = (boot.allLocations || []).find(l => /restaurant/i.test(l.name))
    setBasket(b => [...b, { key: crypto.randomUUID(), item: null, description,
                            tier: 'general', qty, unitPrice, priceOverridden: true,
                            locationId: restaurant?.id, locationName: restaurant?.name || 'Restaurant',
                            orderType: orderType === 'staff' ? 'staff' : 'standard',
                            writeoffNote: writeoffNote || null }])
  }

  // switching the basket tier reprices everything already in it, EXCEPT
  // lines someone has hand-priced — those stay as entered
  function switchTier(t) {
    setDefaultTier(t)
    setBasket(b => b.map(l => (l.priceOverridden || !l.item) ? l
      : { ...l, tier: t, unitPrice: priceFor(l.item, t) }))
  }
  const patchLine = (key, patch) =>
    setBasket(b => b.map(l => l.key === key ? { ...l, ...patch } : l))
  const dropLine = (key) => setBasket(b => b.filter(l => l.key !== key))

  async function switchPayment(row, method) {
    setSwitchingId(row.id)
    try {
      await updateSaleWithPayments(row.id, {
        qty: row.qty, unitPrice: row.unit_price,
        payments: [{ method, amount: row.amount }], businessDate: null })
      toast('Changed to ' + methodLabel[method], 'success')
      refresh()
    } catch (e) { toast('Not changed: ' + e.message, 'error') }
    setSwitchingId(null)
  }

  const saveTillResult = (r) => recordTillCheck({
    branchId: staff.branch_id, locationId, date,
    appPos: r.appPos, appCash: r.appCash, pos: r.pos, cash: r.cash })

  async function undoLast() {
    if (!window.confirm('Undo the last sale? It will be removed as if it never happened.')) return
    try {
      await undoRecentReceipt(lastReceiptId)
      toast('Last sale undone', 'success')
      setLastReceiptId(null); refresh()
    } catch (e) { toast('Not undone: ' + e.message, 'error') }
  }

  // finding 4: warn before recording more than the location holds
  function startPayment() {
    const over = basket.filter(l => l.item && l.qty > onHand(l.item.id, l.locationId))
    if (over.length) {
      const names = over.map(l => `${l.item.name} (${onHand(l.item.id, l.locationId)} left, selling ${l.qty})`).join('\n')
      if (!window.confirm(`More than the shelf shows:\n\n${names}\n\nRecord anyway?`)) return
    }
    // Rushing fat-finger check: a quantity far above what this item usually
    // sells in a day is more often a typo (12 instead of 2) than a sale.
    const big = basket.filter(l => {
      if (!l.item) return false
      const soldToday = Math.max(0, ...today.filter(r => r.stock_item_id === l.item.id)
        .map(r => Number(r.qty) || 0))
      return l.qty >= Math.max(10, 4 * soldToday)
    })
    if (big.length) {
      const names = big.map(l => `${l.item.name} × ${l.qty}`).join('\n')
      if (!window.confirm(`That is a big quantity:\n\n${names}\n\nIs it right?`)) return
    }
    setPaying({
      method: methods[0], split: null,
      customerId: null, newCustomer: '',
    })
  }

  const creditAmount = (p) =>
    p.split ? Number(p.split.credit || 0) : (p.method === 'credit' ? basketTotal : 0)

  // Occupied rooms only — a reservation has not arrived, so there is no
  // one at the bar to charge. Internal rooms (GM Office) excluded.
  useEffect(() => {
    if (!paying) return
    loadLiveStays(staff.branch_id)
      .then(rows => setInHouse((rows || [])
        .filter(r => r.status === 'occupied' && !r.rooms?.is_internal)
        .sort((a, b) => String(a.rooms?.room_number).localeCompare(
          String(b.rooms?.room_number), undefined, { numeric: true }))))
      .catch(() => setInHouse([]))
  }, [!!paying, staff.branch_id])

  const looksLikeRoom = (name) =>
    /\b(room|rm)\.?\s*\d+/i.test(name) || /^\s*\d{3}\s*$/.test(name)

  function chooseRoomBill(stay) {
    setPaying(p => ({ ...p, customerId: null, split: null, method: 'credit',
      roomStay: { id: stay.id, room: stay.rooms?.room_number, guestName: stay.guests?.full_name, since: stay.check_in_date } }))
    setGuestChoice(null); setRoomGuard(null)
  }

  async function chooseSeparateTab(stay) {
    try {
      const c = await getOrCreateGuestTab(staff.branch_id, stay.guests)
      setCustomers(cs => cs.some(x => x.id === c.id) ? cs : [...cs, c])
      setPaying(p => ({ ...p, customerId: c.id, roomStay: null }))
      setGuestChoice(null); setRoomGuard(null)
    } catch (e) { toast(e.message, 'error') }
  }

  async function createAndPick(name, servedBy) {
    try {
      const c = await createCustomer(staff.branch_id, name, servedBy)
      setCustomers(cs => cs.some(x => x.id === c.id) ? cs : [...cs, c])
      setPaying(p => ({ ...p, customerId: c.id }))
    } catch (e) { toast(e.message, 'error') }
  }

  async function commit() {
    if (!canRecordHere) {
      toast('View only — you can record only at your own departments', 'error')
      return
    }
    // Room bill: the whole basket goes onto the guest's folio as a room
    // charge — not a sale, so not saveBasket. One order, one line per item.
    if (paying.roomStay) {
      setBusy(true)
      try {
        const res = await chargeBasketToRoom({ staff, stayId: paying.roomStay.id, lines: basket,
                                               locationId, date, locById })
        // Over the branch limit and made by bar staff: it waits for the
        // front desk. Say so plainly, so nobody thinks it is on the bill.
        // Kept as a branch, not deleted: with approvals off nothing is
        // ever pending, but if the limit is set again this message
        // returns on its own.
        if (res.status === 'pending') {
          toast(`Sent to front desk for approval · Room ${paying.roomStay.room} · ${naira(basketTotal)}. ` +
                'Not on the bill until they approve it.', 'success', { duration: 12000 })
        } else {
          toast(`Charged to Room ${paying.roomStay.room} · ${naira(basketTotal)}`, 'success')
        }
        setBasket([]); setPaying(null); setDefaultTier('general'); refresh()
      } catch (e) {
        toast(isConnectionError(e)
          ? 'No connection — room charges need to be online. Try again shortly.'
          : 'Not charged: ' + e.message, 'error')
      }
      setBusy(false)
      return
    }
    setBusy(true)
    try {
      const customerId = paying.customerId
      if (creditAmount(paying) > 0 && !customerId) {
        toast('Credit sales need a customer — pick or add one.', 'error'); setBusy(false); return
      }
      const payments = paying.split
        ? methods.map(m => ({ method: m, amount: Number(paying.split[m] || 0) }))
        : [{ method: paying.method, amount: basketTotal }]

      const allocated = payments.reduce((s, p) => s + p.amount, 0)
      const diff = Number((basketTotal - allocated).toFixed(2))
      if (Math.abs(diff) > 0.005) {
        const msg = diff > 0
          ? `${naira(diff)} unaccounted. Record it as credit, or correct the amount.`
          : `${naira(-diff)} more allocated than the sale is worth.`
        if (!canOverrideVariance) { toast(msg, 'error'); setBusy(false); return }
        if (!window.confirm(msg + '\n\nSave anyway? It will appear in the variance report.')) {
          setBusy(false); return
        }
      }

      const payload = {
        staffLite: { id: staff.id, branch_id: staff.branch_id },
        locationId, date, customerId,
        lines: basket.map(l => ({
          item: l.item ? { id: l.item.id, name: l.item.name } : null,
          description: l.description || null,
          tier: l.tier, qty: l.qty, unitPrice: l.unitPrice, locationId: l.locationId,
          orderType: l.orderType, writeoffNote: l.writeoffNote })),
        payments, backdateReason, onBehalfOf,
      }
      try {
        const rid = await saveBasket({ staff, locationId, lines: basket, payments,
                                       date, customerId, backdateReason, onBehalfOf })
        toast(`Saved · ${basket.length} item${basket.length > 1 ? 's' : ''} · ${naira(basketTotal)}`, 'success')
        setLastReceiptId(rid); setLastReceiptAt(Date.now())
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'basket', payload })
        toast('No connection — saved and will send when you are back online')
      }
      setBasket([]); setPaying(null); setDefaultTier('general'); refresh(); flush()
    } catch (e) {
      toast('Not saved: ' + e.message, 'error')
    }
    setBusy(false)
  }

  async function commitWriteoff() {
    if (!canRecordHere) {
      toast('View only — you can record only at your own departments', 'error')
      return
    }
    setBusy(true)
    const w = writeoff
    try {
      const wDate = w.date || date
      const payload = { staffLite: { id: staff.id, branch_id: staff.branch_id },
        itemId: w.item.id, locationId, kind: w.kind, qty: w.qty, unitValue: w.unitValue, date: wDate,
        note: w.note || null, damageReason: w.kind === 'damage' ? (w.damageReason || null) : null }
      try {
        await saveWriteoff({ staff, item: w.item, locationId, kind: w.kind,
          qty: w.qty, unitValue: w.unitValue, date: wDate,
          note: w.note || null, damageReason: w.kind === 'damage' ? (w.damageReason || null) : null })
        toast(`${w.qty} × ${w.item.name} recorded as ${w.kind === 'damage' ? 'damaged' : 'PR'}`, 'success')
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'writeoff', payload })
        toast('No connection — saved and will send when you are back online')
      }
      setWriteoff(null); refresh(); flush()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  const todayTotal = today.reduce((s, r) => s + Number(r.amount || r.qty * r.unit_price), 0)

  return (
    <div className="px-5 pb-40">
      <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
        {salesPoints.map(l => (
          <button key={l.id} onClick={() => setLocationId(l.id)}
            className={`shrink-0 h-11 px-4 rounded-full border ${l.id === locationId
              ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
            {l.name}
          </button>
        ))}
      </div>

      {canBackdate ? (
        <div className="mt-2 flex items-center gap-3">
          <input type="date" value={date} max={todayDate} min={earliestDate}
            onChange={e => {
              const v = e.target.value
              if (!v) return
              if (v > todayDate) {
                setDate(todayDate); toast('You cannot post a future date', 'error'); return
              }
              if (earliestDate && v < earliestDate) {
                setDate(earliestDate)
                toast(canOverrideVariance
                  ? 'That is before the opening balance'
                  : `You can only post back ${STAFF_BACKDATE_DAYS} days`, 'error')
                return
              }
              setDate(v)
            }}
            className={`h-12 px-3 rounded-xl bg-surface border tnum ${date !== todayDate
              ? 'border-amber text-amber' : 'border-line'}`} />
          {date !== todayDate && (
            <input value={backdateReason} placeholder="Reason (optional)"
              onChange={e => setBackdateReason(e.target.value)}
              className="h-12 flex-1 px-3 rounded-xl bg-surface border border-line" />
          )}
        </div>
      ) : null}
      {date !== todayDate && (
        <p className="mt-2 text-amber text-sm">
          Posting to {new Date(date + 'T12:00:00').toLocaleDateString('en-NG',
            { weekday: 'long', day: 'numeric', month: 'long' })} — not today.
        </p>
      )}
      {canBackdate && !canOverrideVariance && (
        <p className="mt-1 text-dim text-sm">
          You can post up to {STAFF_BACKDATE_DAYS} days back. Ask a manager for anything older.
        </p>
      )}

      {/* Price tiers and PR/Damage only matter when recording. */}
      {!isReception && !isRestaurant && tiers.length > 1 && canRecordHere && (
        <div className="mt-3">
          <div className="flex gap-2">
            {tiers.map(t => (
              <button key={t} onClick={() => switchTier(t)}
                className={`flex-1 h-12 rounded-xl border font-bold ${defaultTier === t
                  ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                {tierLabel[t] || t}
              </button>
            ))}
            {/* Bar and minimart staff record their own PR and breakages
                (migration 283): making them find a manager meant it went
                unrecorded and surfaced later as an unexplained shortage.
                Every line shows on the daily close with who recorded it.
                Auditors are excluded — they review write-offs. */}
            {canWriteOff && (
              <button onClick={() => { setWriteoffMode(true); setPicking(true) }}
                className="flex-1 h-12 rounded-xl border border-clay text-clay font-bold">
                PR / Damage
              </button>
            )}
          </div>
          {defaultTier !== 'general' && (
            <p className="mt-2 text-amber text-sm">
              {tierLabel[defaultTier]} prices — everything added is priced at this tier.
              {defaultTier === 'staff' && ' Name the staff member below so the receipt shows who took it.'}
            </p>
          )}
        </div>
      )}

      {!isReception && (
        <button onClick={() => setRoomCharging(true)}
          className="mt-3 w-full h-12 rounded-xl border border-line text-ink font-semibold">
          Charge to a room
        </button>
      )}

      {!isReception && canRecordHere && (
        <button onClick={() => setRestaurantOrder({ description: '', qty: 1, unitPrice: '',
          orderType: 'standard', damageReason: null, writeoffNote: '', prMeal: null, date: null })}
          className="mt-3 w-full h-12 rounded-xl border border-line text-ink font-semibold">
          Add a restaurant order
        </button>
      )}

      {!isReception && canRecordOnBehalf && people.length > 0 && (
        <div className="mt-3">
          <div className="text-dim text-sm mb-2">Recording on behalf of (staff at this location)</div>
          <select value={onBehalfOf || ''} onChange={e => setOnBehalfOf(e.target.value || null)}
            className="h-12 w-full px-3 rounded-xl bg-surface border border-line">
            <option value="">Myself</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          {onBehalfOf && (
            <p className="mt-1 text-amber text-sm">
              This sale will appear on {people.find(p => p.id === onBehalfOf)?.full_name}'s records.
            </p>
          )}
        </div>
      )}

      {isReception ? (
        // Reception doesn't sell catalog stock at all — check-in,
        // checkout, and room charges belong on the Rooms tab. Shows a
        // real activity feed below (payments collected today), since
        // Reception has no sales rows at all by design — the parallel
        // to a bar's daily sales here is money collected, not items sold.
        <div className="mt-3 rounded-2xl border border-line bg-surface p-4">
          <p className="font-semibold">Reception doesn't record sales here.</p>
          <p className="text-dim text-sm mt-1">
            Check-in, checkout, room status, and settling a guest's bill are all
            on the Rooms tab.
          </p>
        </div>
      ) : !isRestaurant && canRecordHere && (
        <button onClick={() => setPicking(true)}
          className="mt-3 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold active:bg-amber-deep">
          + Sell Item
        </button>
      )}

      {approvalsOn && !isReception && canRecordHere && (
        <MyPendingRoomCharges branchId={staff.branch_id} staffId={staff.id} onDecided={refresh} />
      )}

      {approvalsOn && !isReception && canRecordHere && (
        <CollectRefusedCharges branchId={staff.branch_id} locationId={locationId}
          methods={methods} customers={customers}
          onCreateCustomer={async (name, servedBy) => {
            try {
              const c = await createCustomer(staff.branch_id, name, servedBy)
              setCustomers(cs => cs.some(x => x.id === c.id) ? cs : [...cs, c])
              return c
            } catch (e) { toast(e.message, 'error'); return null }
          }}
          onCollected={refresh} />
      )}

      {/* Shown instead of the recording buttons, so the missing
          controls read as deliberate rather than as a broken page. */}
      {!canRecordHere && (
        <p className="mt-3 px-4 py-3 rounded-xl bg-raise border border-line text-dim text-sm">
          Viewing {currentDept?.name || 'this department'}. You can see its sales here,
          but you can only record sales at your own departments.
        </p>
      )}

      {approvalsOn && isReception && canApprove && (
        <RoomChargeApprovals branchId={staff.branch_id} onDecided={refresh} />
      )}

      {isReception && (
        <ReceptionDashboard dashboard={receptionDashboard}
          canSeeInternal={isGmOrAdmin} roomsSold={roomsSold} showRoomsSold={isGmOrAdmin} />
      )}

      {isReception && receptionDashboard && (
        <MatchTill rows={[]} posTotal={receptionDashboard.pos} cashTotal={receptionDashboard.cash} onRecord={saveTillResult} />
      )}

      {isReception && (
        <div className="mt-3">
          <button onClick={() => setShowYesterday(x => !x)}
            className="w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
            {showYesterday ? 'Hide' : 'Show'} yesterday's snapshot ({lagosDaysAgo(1)})
          </button>
          {showYesterday && (
            <div className="mt-2 rounded-2xl border border-line bg-surface p-4">
              {yesterdaySummary ? (
                <div className="grid grid-cols-3 gap-3 pb-3 mb-3 border-b border-line">
                  <div>
                    <div className="text-dim text-sm">POS</div>
                    <div className="tnum font-bold">{naira((yesterdaySummary.byMethod || {}).pos || 0)}</div>
                  </div>
                  <div>
                    <div className="text-dim text-sm">Cash</div>
                    <div className="tnum font-bold">{naira((yesterdaySummary.byMethod || {}).cash || 0)}</div>
                  </div>
                  <div>
                    <div className="text-dim text-sm">Credit raised</div>
                    <div className="tnum font-bold text-clay">{naira(yesterdaySummary.creditRaised)}</div>
                  </div>
                </div>
              ) : <p className="text-dim text-sm">Loading…</p>}

              <p className="text-dim text-sm mb-1">Payments collected</p>
              {(yesterdayActivity || []).map(p => (
                <div key={p.id} className="flex justify-between text-sm py-1 border-b border-line/60 last:border-0">
                  <span className="truncate">
                    {p.stays?.guests?.full_name || 'Guest'} · Room {p.stays?.rooms?.room_number || '—'}
                    <span className="text-dim"> · {methodLabel[p.method] || p.method}</span>
                  </span>
                  <span className="tnum font-semibold">{naira(p.amount)}</span>
                </div>
              ))}
              {yesterdayActivity && !yesterdayActivity.length && (
                <p className="text-dim text-sm">No payments that day.</p>
              )}
              {!yesterdayActivity && <p className="text-dim text-sm">Loading…</p>}
            </div>
          )}
        </div>
      )}

      {isReception && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-dim">Today at Reception</h2>
            <span className="tnum font-bold text-lg">
              {naira(receptionActivity.reduce((s, p) => s + Number(p.amount || 0), 0))}
            </span>
          </div>
          <ul className="mt-2 divide-y divide-line/60">
            {receptionActivity.map(p => (
              <li key={p.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">
                    {p.stays?.guests?.full_name || 'Guest'} · Room {p.stays?.rooms?.room_number || '—'}
                  </div>
                  <div className="text-dim text-sm">
                    {methodLabel[p.method] || p.method}{p.is_overstay ? ' · over-stay' : ''}
                    {p.staff?.full_name && ` · collected by ${p.staff.full_name}`}
                    {p.remark ? ` · ${p.remark}` : ''}
                  </div>
                </div>
                <span className="tnum font-semibold">{naira(p.amount)}</span>
              </li>
            ))}
            {!receptionActivity.length && (
              <li className="py-6 text-dim">No payments recorded yet today.</li>
            )}
          </ul>
        </div>
      )}

      {!!basket.length && (
        <ul className="mt-4 divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
          {basket.map(l => (
            <li key={l.key} className="py-3">
              <div className="flex items-center gap-3">
                <button onClick={() => setTuning(l.key)} className="flex-1 min-w-0 text-left">
                  <div className="font-semibold truncate">{l.item?.name || l.description}</div>
                  <div className="text-sm">
                    <span className={l.tier === 'general' ? 'text-dim' : 'text-amber font-semibold'}>
                      {tierLabel[l.tier] || l.tier}
                    </span>
                    <span className="text-dim"> · {naira(l.unitPrice)} each</span>
                    {l.locationName && <span className="text-dim"> · from {l.locationName}</span>}
                  </div>
                </button>
                <button onClick={() => patchLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-2xl">−</button>
                <span className="tnum w-8 text-center font-bold">{l.qty}</span>
                <button onClick={() => patchLine(l.key, { qty: l.qty + 1 })}
                  className="h-11 w-11 rounded-xl bg-raise border border-line text-2xl">+</button>
                <span className="tnum w-20 text-right">{naira(l.qty * l.unitPrice)}</span>
              </div>
              {l.item && l.qty > onHand(l.item.id, l.locationId) && (
                <p className="text-clay text-sm mt-1">Only {l.item && onHand(l.item.id, l.locationId)} on the shelf</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {lastReceiptId && (
        <button onClick={() => openReceipt(lastReceiptId)}
          className="mt-3 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
          Receipt for the last sale
        </button>
      )}

      {lastReceiptId && Date.now() - lastReceiptAt < 10 * 60 * 1000 && lastReceiptAt > 0 && (
        <button onClick={undoLast}
          className="mt-2 w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
          Wrong? Undo the last sale (10 minutes)
        </button>
      )}

      {!isReception && (
      <section className="mt-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-dim">Today</h2>
            <p className="text-dim text-sm">
              {new Date(date + 'T12:00:00').toLocaleDateString('en-NG',
                { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <span className="tnum font-bold text-lg">{naira(todayTotal)}</span>
        </div>

        <MatchTill rows={today} busyId={switchingId} onSwitch={switchPayment} onRecord={saveTillResult}
          itemName={r => itemById[r.stock_item_id]?.name || r.description || ''} />

        {recon && (
          <div className="mt-3 rounded-2xl border border-amber bg-surface p-4">
            <div className="text-dim text-sm">Gross sales — value of goods sold</div>
            <div className="tnum text-3xl font-bold text-amber">{naira(recon.grossSales)}</div>
            <div className="mt-3 space-y-1 text-sm">
              <Line label="Received at sale (POS + Cash)" value={recon.received} />
              <Line label="Credit raised" value={recon.creditRaised}
                tone={recon.creditRaised > 0 ? 'text-clay' : ''} />
              {recon.unqualifiedCredit > 0 && (
                <div className="flex justify-between text-clay">
                  <span>Not repaid by noon next day — excluded from sales above</span>
                  <span className="tnum">{naira(recon.unqualifiedCredit)}</span>
                </div>
              )}
              <Line label="Debt recovered (earlier sales)" value={recon.debtRecovered} tone="text-leaf" />
              {Object.entries(recon.recoveredBy || {}).map(([m, amt]) => (
                <div key={m} className="flex justify-between pl-4">
                  <span className="text-dim">· recovered by {methodLabel[m] || m}</span>
                  <span className="tnum text-dim">{naira(amt)}</span>
                </div>
              ))}
              <div className="pt-2 mt-2 border-t border-line flex justify-between font-bold">
                <span>Total income for the day</span>
                <span className="tnum">{naira(recon.totalMoneyIn)}</span>
              </div>
            </div>

            {/* Below the day's total and outside its border: neither PR
                nor damage is money, and neither is part of what the
                cashier hands over.

                PR and damage are shown SEPARATELY and itemised. They are
                different things — PR is a decision someone made, damage
                is a loss — and "Damaged 6 units · ₦22,000" tells you
                neither what broke nor why. Each line names the item,
                quantity, cost, reason and who recorded it, so it can be
                checked against the breakages. */}
            <WriteoffBreakdown data={writeoffs} settled={recon} />

          </div>
        )}

        {summary && (
          <div className="mt-3 rounded-2xl border border-line bg-surface p-4">
            <div className="grid grid-cols-3 gap-3">
              {methods.map(m => (
                <div key={m}>
                  <div className="text-dim text-sm">{methodLabel[m] || m}</div>
                  <div className="tnum font-bold">{naira(summary.byMethod[m] || 0)}</div>
                </div>
              ))}
            </div>
            {/* The old totals-only block ("Damaged 6 units · ₦22,000")
                lived here. Replaced by the itemised PR and damage
                sections above, which name the item, reason and who
                recorded it. Two blocks showing the same figures
                differently would only confuse the cash-up. */}
          </div>
        )}

        <ul className="mt-3 divide-y divide-line/60">
          {combinedToday.slice(0, 20).map(r => (
            <li key={`${r.entryKind}:${r.id}`} className="py-3 flex items-center gap-3"
                onClick={() => r.entryKind === 'sale' && openReceipt(r.receipt_id)}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate flex items-center gap-2">
                  <span className="truncate">{itemById[r.stock_item_id]?.name || r.description || '—'}</span>
                  {r.order_type === 'pr_damage' && (
                    <span className="shrink-0 text-xs font-bold text-clay border border-clay rounded-full px-2 py-0.5">
                      PR / Damage
                    </span>
                  )}
                  {r.order_type === 'staff' && (
                    <span className="shrink-0 text-xs font-bold text-amber border border-amber rounded-full px-2 py-0.5">
                      Staff
                    </span>
                  )}
                </div>
                {r.entryKind === 'roomCharge' ? (
                  <div className="text-dim text-sm">
                    {r.qty} × {naira(r.unit_price)}
                    <br />Charged to Room {r.roomNumber || '—'}
                    {r.guestName ? ` · ${r.guestName}` : ''}
                    {r.order_type === 'pr_damage' && ' · not paid for'}
                    {(r.damage_reason || r.pr_meal) && ` · ${r.damage_reason || r.pr_meal}`}
                    {r.writeoff_note && ` · ${r.writeoff_note}`}
                  </div>
                ) : r.order_type === 'pr_damage' ? (
                  <div className="text-dim text-sm">
                    {r.qty} × {naira(r.unit_price)} · not paid for
                    {(r.damage_reason || r.pr_meal) && ` · ${r.damage_reason || r.pr_meal}`}
                    {r.writeoff_note && ` · ${r.writeoff_note}`}
                    <br />{whoRecorded(r)}
                  </div>
                ) : r.order_type === 'staff' ? (
                  <div className="text-dim text-sm">
                    {tierLabel[r.tier] || r.tier} · {r.qty} × {naira(r.unit_price)}
                    {r.writeoff_note && ` · ${r.writeoff_note}`}
                    <br />{paymentSummary(r)} · {whoRecorded(r)}
                  </div>
                ) : (
                  <div className="text-dim text-sm">
                    {tierLabel[r.tier] || r.tier} · {r.qty} × {naira(r.unit_price)}
                    {r.business_date !== r.created_at?.slice(0, 10) && (
                      <span className="ml-2 text-amber">backdated</span>
                    )}
                    <br />{paymentSummary(r)} · {whoRecorded(r)}
                  </div>
                )}
              </div>
              <div className="tnum font-semibold">{naira(r.amount ?? r.qty * r.unit_price)}</div>
              {canDeleteTraining && (
                <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(r) }}
                  className="h-9 px-3 rounded-lg border border-clay text-clay text-sm font-semibold shrink-0">
                  Delete
                </button>
              )}
            </li>
          ))}
          {!combinedToday.length && <li className="py-6 text-dim">No sales recorded yet — the first one goes on top.</li>}
        </ul>
      </section>
      )}

      {!!basket.length && (
        <div className="fixed bottom-20 inset-x-0 px-5 pb-2 z-20">
          <button onClick={startPayment}
            className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold shadow-lg active:bg-amber-deep">
            Take payment · {naira(basketTotal)}
          </button>
        </div>
      )}

      {picking && (
        <ItemPicker items={items} stockMap={stockMap} locationId={locationId}
          popular={popular}
          onPick={item => {
            if (writeoffMode) {
              setPicking(false); setWriteoffMode(false)
              setWriteoff({ item, kind: 'damage', qty: 1, unitValue: Number(item.selling_price) })
            } else addToBasket(item)
          }}
          onClose={() => { setPicking(false); setWriteoffMode(false) }} />
      )}

      {tuning && (() => {
        const l = basket.find(x => x.key === tuning)
        if (!l) return null
        return (
          <Sheet onClose={() => setTuning(null)}>
            <h2 className="text-2xl font-bold">{l.item?.name || l.description}</h2>
            {l.item ? (
              <>
                <Row label="Price tier">
                  {tiers.map(t => (
                    <Chip key={t} active={l.tier === t}
                      onClick={() => patchLine(l.key, { tier: t, unitPrice: priceFor(l.item, t), priceOverridden: false })}>
                      {tierLabel[t] || t}
                    </Chip>
                  ))}
                </Row>
                <Row label="Unit price">
                  <input type="number" inputMode="decimal" value={l.unitPrice}
                    onChange={e => patchLine(l.key, { unitPrice: Number(e.target.value), priceOverridden: true })}
                    className="h-12 w-36 px-3 rounded-xl bg-surface border border-line tnum" />
                  {l.priceOverridden && (
                    <button onClick={() => patchLine(l.key, { unitPrice: priceFor(l.item, l.tier), priceOverridden: false })}
                      className="text-dim text-sm underline">Reset to {tierLabel[l.tier] || l.tier} price</button>
                  )}
                </Row>
              </>
            ) : (
              // typed order — no catalog item, so no tier concept;
              // just the description and the price as entered
              <>
                <Row label="Order">
                  <input value={l.description}
                    onChange={e => patchLine(l.key, { description: e.target.value })}
                    className="h-12 w-full px-3 rounded-xl bg-surface border border-line" />
                </Row>
                <Row label="Unit price">
                  <input type="number" inputMode="decimal" value={l.unitPrice}
                    onChange={e => patchLine(l.key, { unitPrice: Number(e.target.value) })}
                    className="h-12 w-36 px-3 rounded-xl bg-surface border border-line tnum" />
                </Row>
              </>
            )}
            <button onClick={() => { dropLine(l.key); setTuning(null) }}
              className="mt-8 w-full h-12 rounded-xl border border-clay text-clay font-semibold">
              Remove from basket
            </button>
            <button onClick={() => setTuning(null)}
              className="mt-3 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold">Done</button>
          </Sheet>
        )
      })()}

      {paying && (
        <Sheet onClose={() => setPaying(null)}>
          <h2 className="text-2xl font-bold">Payment</h2>
          <p className="mt-1 text-3xl tnum text-amber font-bold">{naira(basketTotal)}</p>
          <p className="text-dim mt-1">{basket.length} item{basket.length > 1 ? 's' : ''}</p>

          <Row label="Paid by">
            {methods.map(m => (
              <Chip key={m} active={!paying.split && paying.method === m}
                onClick={() => setPaying(p => ({ ...p, method: m, split: null }))}>
                {methodLabel[m] || m}
              </Chip>
            ))}
            <Chip active={!!paying.split}
              onClick={() => setPaying(p => ({ ...p,
                split: p.split || Object.fromEntries(methods.map(m => [m, ''])) }))}>
              Split
            </Chip>
          </Row>

          <Allocation total={basketTotal} paying={paying} methods={methods}
            onCredit={() => setPaying(p => {
              const alloc = p.split
                ? Object.entries(p.split).reduce((s, [k, v]) => k === 'credit' ? s : s + Number(v || 0), 0)
                : (p.method === 'credit' ? 0 : basketTotal)
              const split = p.split || Object.fromEntries(methods.map(m =>
                [m, m === p.method ? String(basketTotal) : '']))
              return { ...p, split: { ...split, credit: String(Math.max(basketTotal - alloc, 0)) } }
            })} />

          {paying.split && (
            <div className="mt-3 space-y-2">
              {methods.map(m => (
                <div key={m} className="flex items-center gap-3">
                  <span className="w-20 text-dim">{methodLabel[m] || m}</span>
                  <input type="number" inputMode="decimal" placeholder="0" value={paying.split[m]}
                    onChange={e => setPaying(p => ({ ...p, split: { ...p.split, [m]: e.target.value } }))}
                    className="h-12 flex-1 px-3 rounded-xl bg-surface border border-line tnum" />
                </div>
              ))}
              <SplitCheck split={paying.split} total={basketTotal} />
            </div>
          )}

          {paying.roomStay ? (
            <div className="mt-6 rounded-2xl border border-amber bg-surface p-4">
              <div className="text-dim text-sm">Room bill</div>
              <div className="font-bold text-lg">
                Room {paying.roomStay.room} · {paying.roomStay.guestName}
              </div>
              {paying.roomStay.since && (
                <div className="text-dim text-sm">Checked in {niceDay(paying.roomStay.since)}</div>
              )}
              <p className="text-dim text-sm mt-1">
                The whole sale ({naira(basketTotal)}) goes on this guest's room bill
                and is collected at checkout.
              </p>
              <button onClick={() => setPaying(p => ({ ...p, roomStay: null }))}
                className="mt-2 text-amber text-sm underline">Change</button>
            </div>
          ) : (
          <div className="mt-6">
            {/* Guests first, at the moment the credit decision is made —
                the whole point. Previously a bartender reached this step
                already committed to a customer account, and the correct
                path (charge to room) was a separate button further up. */}
            {creditAmount(paying) > 0 && !!inHouse.length && !guestChoice && !roomGuard && (
              <div className="mb-5">
                <div className="text-dim mb-2">In-house guest?</div>
                <div className="space-y-2 max-h-56 overflow-y-auto">
                  {inHouse.map(st => (
                    <button key={st.id} onClick={() => { setRoomGuard(null); setGuestChoice(st) }}
                      className="w-full h-12 px-4 rounded-xl border border-line text-left flex items-center gap-3">
                      <span className="font-bold tnum w-20 shrink-0">Rm {st.rooms?.room_number}</span>
                      <span className="truncate">{st.guests?.full_name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {guestChoice && (
              <div className="mb-5 rounded-2xl border border-amber bg-surface p-4">
                <div className="font-bold">
                  Room {guestChoice.rooms?.room_number} · {guestChoice.guests?.full_name}
                </div>
                <p className="mt-2 text-sm font-semibold">
                  Charge {naira(basketTotal)} to Room {guestChoice.rooms?.room_number} · {guestChoice.guests?.full_name}
                  {guestChoice.check_in_date ? ` (checked in ${niceDay(guestChoice.check_in_date)})` : ''}
                </p>
                <p className="text-dim text-sm mt-1">
                  Is this the right guest? Check the name and room before charging.
                </p>
                <button onClick={() => chooseRoomBill(guestChoice)}
                  className="mt-3 w-full h-12 rounded-xl bg-amber text-bg font-bold">
                  Add to room bill
                </button>
                <button onClick={() => chooseSeparateTab(guestChoice)}
                  className="mt-2 w-full h-12 rounded-xl border border-amber text-amber font-semibold">
                  Separate bar tab
                </button>
                <p className="text-dim text-xs mt-2">
                  A separate tab is billed on its own (e.g. for company expenses) but
                  still shows to the front desk at checkout.
                </p>
                <button onClick={() => setGuestChoice(null)}
                  className="mt-2 w-full h-10 text-dim text-sm">Cancel</button>
              </div>
            )}

            {roomGuard && (
              <div className="mb-5 rounded-2xl border border-clay bg-surface p-4">
                <p className="text-clay text-sm">
                  "{roomGuard.name}" looks like a hotel guest. Charge it to their room,
                  or their own tab, instead?
                </p>
                <div className="space-y-2 mt-3 max-h-56 overflow-y-auto">
                  {inHouse.map(st => (
                    <button key={st.id} onClick={() => { setRoomGuard(null); setGuestChoice(st) }}
                      className="w-full h-12 px-4 rounded-xl border border-line text-left flex items-center gap-3">
                      <span className="font-bold tnum w-20 shrink-0">Rm {st.rooms?.room_number}</span>
                      <span className="truncate">{st.guests?.full_name}</span>
                    </button>
                  ))}
                </div>
                <button onClick={() => { const g = roomGuard; setRoomGuard(null); createAndPick(g.name, g.servedBy) }}
                  className="mt-3 w-full h-11 rounded-xl border border-line text-dim text-sm">
                  Not a guest — create "{roomGuard.name}" anyway
                </button>
              </div>
            )}

            <div className="text-dim mb-2">
              {creditAmount(paying) > 0
                ? 'Customer (required for credit)'
                : 'Customer (optional — for a named receipt)'}
            </div>
              <CustomerPicker branchId={staff.branch_id} customers={customers} value={paying.customerId}
                onPick={id => setPaying(p => ({ ...p, customerId: id }))}
                onCreate={async (name, servedBy) => {
                  // Room-numbered accounts ("Room 203 Mr Vincent") are the
                  // habit that split guests' debt from their folio. Caught
                  // here and redirected, with an escape hatch for the rare
                  // genuine name that happens to match.
                  if (looksLikeRoom(name) && inHouse.length) {
                    setRoomGuard({ name, servedBy }); return
                  }
                  await createAndPick(name, servedBy)
                }} />
          </div>
          )}

          <button onClick={commit} disabled={busy}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…'
              : paying.roomStay ? `Charge to Room ${paying.roomStay.room}` : 'Save sale'}
          </button>
        </Sheet>
      )}

      {receipt && (
        <Receipt lines={receipt} branchName={boot.branchName} locById={locById}
          onClose={() => setReceipt(null)} />
      )}

      {writeoff && (
        <Sheet onClose={() => setWriteoff(null)}>
          <h2 className="text-2xl font-bold">{writeoff.item.name}</h2>
          <p className="text-dim mt-1">Not a sale — this leaves stock without income.</p>
          <Row label="Reason">
            <Chip active={writeoff.kind === 'complimentary'}
              onClick={() => setWriteoff(w => ({ ...w, kind: 'complimentary' }))}>PR / free</Chip>
            <Chip active={writeoff.kind === 'damage'}
              onClick={() => setWriteoff(w => ({ ...w, kind: 'damage' }))}>Damaged</Chip>
          </Row>
          <Row label="Quantity">
            <button onClick={() => setWriteoff(w => ({ ...w, qty: Math.max(1, w.qty - 1) }))}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">−</button>
            <span className="tnum text-3xl font-bold w-14 text-center">{writeoff.qty}</span>
            <button onClick={() => setWriteoff(w => ({ ...w, qty: w.qty + 1 }))}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">+</button>
          </Row>
          <Row label="Value per unit">
            <input type="number" inputMode="decimal" value={writeoff.unitValue}
              onChange={e => setWriteoff(w => ({ ...w, unitValue: Number(e.target.value) }))}
              className="h-12 w-36 px-3 rounded-xl bg-surface border border-line tnum" />
          </Row>
          <Row label="Date">
            <input type="date" value={writeoff.date || date} max={todayDate}
              onChange={e => setWriteoff(w => ({ ...w, date: e.target.value }))}
              className="h-12 px-3 rounded-xl bg-surface border border-line tnum" />
          </Row>
          {writeoff.kind === 'damage' && (
            <Row label="What happened">
              <select value={writeoff.damageReason || ''}
                onChange={e => setWriteoff(w => ({ ...w, damageReason: e.target.value || null }))}
                className="h-12 px-3 rounded-xl bg-surface border border-line">
                <option value="">Pick a reason…</option>
                <option value="breakage">Breakage</option>
                <option value="expiry">Expiry</option>
                <option value="spillage">Spillage</option>
                <option value="theft">Theft</option>
                <option value="spoilage">Spoilage</option>
                <option value="other">Other</option>
              </select>
            </Row>
          )}
          <Row label={writeoff.kind === 'complimentary' ? 'Authorized by / note' : 'Note (optional)'}>
            <input value={writeoff.note || ''}
              onChange={e => setWriteoff(w => ({ ...w, note: e.target.value }))}
              placeholder={writeoff.kind === 'complimentary' ? 'e.g. approved by GM for…' : 'any detail'}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
          </Row>
          {writeoff.kind === 'damage' && !writeoff.damageReason && (
            <p className="text-dim text-sm mt-2">Pick a reason so damage can be tracked by cause.</p>
          )}
          <button onClick={commitWriteoff} disabled={busy || (writeoff.kind === 'damage' && !writeoff.damageReason)}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save write-off'}
          </button>
        </Sheet>
      )}

      {roomCharging && (
        <RoomChargeSheet boot={boot} stockMap={stockMap} toast={toast}
          onClose={() => setRoomCharging(false)} />
      )}

      {restaurantOrder && (
        <Sheet onClose={() => setRestaurantOrder(null)}>
          <h2 className="text-2xl font-bold">Restaurant order</h2>
          <p className="text-dim mt-1">Typed, not tracked as stock — counts toward Restaurant's takings.</p>
          <Row label="What was ordered">
            <input value={restaurantOrder.description} autoFocus
              onChange={e => setRestaurantOrder(r => ({ ...r, description: e.target.value }))}
              placeholder="e.g. Jollof Rice with Chicken"
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
          </Row>
          <Row label="Quantity">
            <button onClick={() => setRestaurantOrder(r => ({ ...r, qty: Math.max(1, r.qty - 1) }))}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">−</button>
            <span className="tnum text-3xl font-bold w-14 text-center">{restaurantOrder.qty}</span>
            <button onClick={() => setRestaurantOrder(r => ({ ...r, qty: r.qty + 1 }))}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">+</button>
          </Row>
          <Row label="Price per plate">
            <input type="number" inputMode="decimal" value={restaurantOrder.unitPrice}
              onChange={e => setRestaurantOrder(r => ({ ...r, unitPrice: e.target.value }))}
              placeholder="0" className="h-12 w-36 px-3 rounded-xl bg-surface border border-line tnum" />
          </Row>

          <label className="block mt-4 text-dim">Order type</label>
          <div className="mt-2 flex gap-2">
            {[['standard', 'Standard'], ['pr_damage', 'PR / Damage'], ['staff', 'Staff']].map(([k, label]) => (
              <button key={k} onClick={() => setRestaurantOrder(r => ({ ...r, orderType: k }))}
                className={`flex-1 h-12 rounded-xl border font-semibold ${restaurantOrder.orderType === k
                  ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                {label}
              </button>
            ))}
          </div>

          {restaurantOrder.orderType === 'staff' && (
            <>
              <p className="text-dim text-sm mt-3">
                A staff meal is free: it is not charged to anyone and does not
                count as a sale.
              </p>
              {/* Moved here from PR/Damage — it is staff meals that are
                  breakfast, lunch or dinner. */}
              <Row label="Which meal">
                <select value={restaurantOrder.prMeal || ''}
                  onChange={e => setRestaurantOrder(r => ({ ...r, prMeal: e.target.value || null }))}
                  className="h-12 px-3 rounded-xl bg-surface border border-line">
                  <option value="">Not specified</option>
                  <option value="breakfast">Breakfast</option>
                  <option value="lunch">Lunch</option>
                  <option value="dinner">Dinner</option>
                </select>
              </Row>
              <Row label="Date">
                <input type="date" value={restaurantOrder.date || date} max={todayDate}
                  onChange={e => setRestaurantOrder(r => ({ ...r, date: e.target.value }))}
                  className="h-12 px-3 rounded-xl bg-surface border border-line tnum" />
              </Row>
            </>
          )}

          {/* PR and DAMAGE are different things and are now asked for
              separately: PR is a decision someone made, damage is a loss.
              Each gets its own detail, so the daily close can show why. */}
          {restaurantOrder.orderType === 'pr_damage' && (
            <>
              <div className="mt-3 flex gap-2">
                {[['pr', 'PR / complimentary'], ['damage', 'Damaged / lost']].map(([k, label]) => (
                  <button key={k}
                    onClick={() => setRestaurantOrder(r => ({ ...r,
                      prKind: k, damageReason: k === 'pr' ? null : (r.damageReason || 'spoilage') }))}
                    className={`flex-1 h-12 rounded-xl border font-semibold ${
                      (restaurantOrder.prKind || (restaurantOrder.damageReason ? 'damage' : 'pr')) === k
                        ? 'bg-clay text-bg border-clay' : 'border-line text-dim'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {(restaurantOrder.prKind || (restaurantOrder.damageReason ? 'damage' : 'pr')) === 'damage' ? (
                <>
                  <p className="text-dim text-sm mt-3">
                    Stock lost. Say how, so it can be checked against what was found.
                  </p>
                  <Row label="What happened">
                    <select value={restaurantOrder.damageReason || 'spoilage'}
                      onChange={e => setRestaurantOrder(r => ({ ...r, damageReason: e.target.value }))}
                      className="h-12 px-3 rounded-xl bg-surface border border-line">
                      <option value="breakage">Breakage</option>
                      <option value="expiry">Expiry</option>
                      <option value="spillage">Spillage</option>
                      <option value="spoilage">Spoilage</option>
                      <option value="theft">Theft</option>
                      <option value="other">Other</option>
                    </select>
                  </Row>
                </>
              ) : (
                <p className="text-dim text-sm mt-3">
                  Given away free. Say who it was for and who approved it.
                </p>
              )}

              <Row label="Date">
                <input type="date" value={restaurantOrder.date || date} max={todayDate}
                  onChange={e => setRestaurantOrder(r => ({ ...r, date: e.target.value }))}
                  className="h-12 px-3 rounded-xl bg-surface border border-line tnum" />
              </Row>
              <label className="block mt-4 text-dim">
                {(restaurantOrder.prKind || (restaurantOrder.damageReason ? 'damage' : 'pr')) === 'damage'
                  ? 'What happened, in your words' : 'Who it was for, and who approved it'}
              </label>
              <input value={restaurantOrder.writeoffNote}
                onChange={e => setRestaurantOrder(r => ({ ...r, writeoffNote: e.target.value }))}
                placeholder="e.g. Approved by GM Chuka"
                className="mt-2 h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
            </>
          )}

          {restaurantOrder.orderType === 'staff' && (
            <>
              <p className="text-dim text-sm mt-3">
                Staff meal — still paid for like a normal order, just tracked separately for reporting.
              </p>
              <label className="block mt-2 text-dim">Note (optional)</label>
              <input value={restaurantOrder.writeoffNote}
                onChange={e => setRestaurantOrder(r => ({ ...r, writeoffNote: e.target.value }))}
                className="mt-2 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
            </>
          )}

          <button
            onClick={async () => {
              const desc = restaurantOrder.description.trim()
              const qty = restaurantOrder.qty
              const unitPrice = Number(restaurantOrder.unitPrice) || 0
              // Only STANDARD is a paid order. Staff meals are a
              // benefit — free, and excluded from sales (migration 289) —
              // so they save straight away like PR, with no payment step.
              if (restaurantOrder.orderType === 'standard') {
                addTypedOrder({ description: desc, qty, unitPrice, orderType: restaurantOrder.orderType,
                                writeoffNote: restaurantOrder.writeoffNote })
                setRestaurantOrder(null)
                return
              }
              setWriteoffBusy(true)
              try {
                const restaurant = (boot.allLocations || []).find(l => /restaurant/i.test(l.name))
                if (!canRecordAt(restaurant?.id)) {
                  toast('View only — you can record only at your own departments', 'error')
                  setWriteoffBusy(false)
                  return
                }
                await saveRestaurantWriteoff({
                  staff, locationId: restaurant?.id, businessDate: restaurantOrder.date || date,
                  description: desc, qty, unitPrice,
                  orderType: restaurantOrder.orderType, damageReason: restaurantOrder.damageReason,
                  writeoffNote: restaurantOrder.writeoffNote, prMeal: restaurantOrder.prMeal,
                })
                toast(restaurantOrder.orderType === 'staff'
                  ? 'Staff meal recorded' : 'Recorded — not paid for', 'success')
                setRestaurantOrder(null); refresh()
              } catch (e) { toast('Not saved: ' + e.message, 'error') }
              setWriteoffBusy(false)
            }}
            disabled={writeoffBusy || !restaurantOrder.description.trim() || !Number(restaurantOrder.unitPrice)}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {writeoffBusy ? 'Saving…'
              : restaurantOrder.orderType === 'standard' ? 'Add to basket'
              : restaurantOrder.orderType === 'staff' ? 'Save staff meal'
              : 'Save — not paid for'}
          </button>
        </Sheet>
      )}

      {deleteConfirm && (
        <Sheet onClose={() => setDeleteConfirm(null)}>
          <h2 className="text-2xl font-bold">Delete this entry?</h2>
          <p className="text-dim mt-2">
            {itemById[deleteConfirm.stock_item_id]?.name || deleteConfirm.description || 'This entry'}
            {' — '}{deleteConfirm.qty} × {naira(deleteConfirm.unit_price)}
          </p>
          <p className="text-dim text-sm mt-1">
            For training records only — this cannot be undone.
          </p>
          <button onClick={doDeleteEntry} disabled={deleteBusy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {deleteBusy ? 'Deleting…' : 'Delete'}
          </button>
          <button onClick={() => setDeleteConfirm(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </Sheet>
      )}
    </div>
  )
}

function Line({ label, value, tone = '' }) {
  return (
    <div className="flex justify-between">
      <span className="text-dim">{label}</span>
      <span className={`tnum ${tone}`}>{naira(value)}</span>
    </div>
  )
}

function Allocation({ total, paying, methods, onCredit }) {
  const allocated = paying.split
    ? Object.values(paying.split).reduce((s, v) => s + Number(v || 0), 0)
    : total
  const diff = Number((total - allocated).toFixed(2))
  return (
    <div className="mt-6 rounded-xl border border-line bg-surface p-4 space-y-1 text-sm">
      <div className="flex justify-between">
        <span className="text-dim">Expected</span>
        <span className="tnum font-bold">{naira(total)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-dim">Allocated</span>
        <span className="tnum">{naira(allocated)}</span>
      </div>
      <div className="flex justify-between pt-1 border-t border-line">
        <span className="text-dim">Difference</span>
        <span className={`tnum font-bold ${Math.abs(diff) < 0.005 ? 'text-leaf' : 'text-clay'}`}>
          {naira(diff)}
        </span>
      </div>
      {diff > 0.005 && methods.includes('credit') && (
        <button onClick={onCredit}
          className="mt-3 w-full h-11 rounded-xl border border-amber text-amber font-semibold">
          Post {naira(diff)} as credit
        </button>
      )}
    </div>
  )
}

function Sheet({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col">
      <div className="p-5 flex-1 overflow-y-auto">
        <button onClick={onClose} className="text-dim">Back</button>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  )
}
function Row({ label, children }) {
  return (
    <div className="mt-6">
      <div className="text-dim mb-2">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
function Chip({ active, onClick, children }) {
  return <button onClick={onClick}
    className={`h-12 px-4 rounded-xl border font-semibold ${active
      ? 'bg-amber text-bg border-amber' : 'border-line text-ink'}`}>{children}</button>
}
function SplitCheck({ split, total }) {
  const entered = Object.values(split).reduce((s, v) => s + Number(v || 0), 0)
  const diff = total - entered
  if (Math.abs(diff) < 0.01) return <p className="text-leaf">Split matches the total.</p>
  return <p className="text-clay tnum">
    {diff > 0 ? naira(diff) + ' left to allocate' : naira(-diff) + ' over the total'}
  </p>
}
