import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, tierLabel, methodLabel, lagosDaysAgo, lagosToday, friendlyStayError, lagosHHMM } from '../lib/format'
import { loadActivity, deleteEntry, updateEntry, loadAudit,
         loadSalePayments, updateSaleWithPayments,
         loadLiveStays, updateGuestIdentity, correctStay,
         findDuplicateGuests, mergeGuests, dismissDuplicatePair,
         findDuplicateCustomers, mergeCustomers } from '../lib/data'
import { useToast } from '../components/Toast'
import MergeGuestsSheet from '../components/MergeGuestsSheet'
import MergeCustomersSheet from '../components/MergeCustomersSheet'
import { MANAGEMENT, RECEPTION_EDIT, SUPERVISOR, is } from '../lib/roles'
import Notice from '../components/Notice'
import { tracked } from '../lib/loadfail'

// The movement labels, in one place. describe() held them inline and
// the row badge needed the same words — two copies drift.
const MOVEMENT_LABEL = {
  restock: 'Received', transfer: 'Disbursed', issue: 'Issued',
  damage: 'Damaged', complimentary: 'PR / free', adjustment: 'Adjustment',
  opening: 'Opening', conversion: 'Converted',
}

// A day of entries or changes, closed unless it is the newest or the
// person opened it. Fourteen days of two departments is several hundred
// rows, and they were all painted at once in one flat list: the only way
// to find Tuesday's entry was to scroll past Wednesday's.
function DayGroup({ label, sub, right, open, onToggle, children }) {
  return (
    <section className="mt-3 rounded-2xl border border-line bg-surface">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full px-4 py-3 flex items-baseline justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="font-semibold">{label}</span>
          {sub && <span className="text-dim text-sm block">{sub}</span>}
        </span>
        <span className="flex items-baseline gap-2 shrink-0">
          {right}
          <svg viewBox="0 0 20 20" className={`w-4 h-4 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
               fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && <div className="px-4 pb-1 border-t border-line">{children}</div>}
    </section>
  )
}

export default function Corrections({ boot }) {
  const { staff, allLocations, locations, items, methods } = boot
  const toast = useToast()
  // Who may correct ANYONE's entries: manager, gm, admin. Mirrors
  // app_can_edit_any() in the database (migration 252). Store managers
  // were editors here until 252; they now correct only their OWN recent
  // entries, like bar staff — segregation of duties, since stock is
  // reconciled against these very sales.
  const isEditor = is(staff.role, MANAGEMENT)
  const isStorekeeper = staff.role === 'storekeeper'
  // Granted per person (staff.can_correct_sales, migration 263b), not by
  // role: currently the Awka auditor only. Mirrors
  // app_can_correct_any_sale() — lets them edit ANYONE's sale, never
  // delete, and never a stock movement.
  const canCorrectSales = !!staff.can_correct_sales
  // Deleting is GM/admin only (migration 256), matching payments and
  // bookings; managers keep EDITING anyone's entries. Mirrors
  // is_supervisor() in delete_sale() and the delete policies.
  const canDeleteAny = is(staff.role, SUPERVISOR)
  // Mirrors app_can_change_sale_date(): store managers, managers, gm,
  // admin, and anyone individually granted corrections. Bar and front
  // desk still fix their own quantity, price and payments, but cannot
  // move a sale to another day.
  // Mirrors app_can_change_sale_date() after 264: manager/gm/admin by
  // role, plus anyone individually granted (Nnewi store manager,
  // Awka auditor). Store managers do NOT get it by role — only Nnewi's
  // was asked for. Bar and front desk still fix their own quantity,
  // price and payments, but cannot move a sale to another day.
  const canChangeDate = is(staff.role, MANAGEMENT) || canCorrectSales
    || !!staff.can_fix_entry_dates
  const canEdit = isEditor || isStorekeeper || canCorrectSales
    || staff.role === 'bar' || staff.role === 'front_desk'
  const ownOnly = !isEditor && !canCorrectSales
  // Store managers keep the all-departments chips (a filter over their
  // own rows), so an entry they made at another counter is never hidden.
  const seesAllDeptChips = isEditor || isStorekeeper || canCorrectSales
  const [rows, setRows] = useState(null)
  // Front desk lands on Reception: it is the tab they actually work
  // in, and Reception has no sales rows by design, so Entries would
  // otherwise open on an empty list for them.
  const landsOnReception = staff.role === 'front_desk'
  const [view, setView] = useState(
    !canEdit ? 'history' : landsOnReception ? 'guests' : 'entries')
  const [audit, setAudit] = useState(null)
  const [edit, setEdit] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  // Shape only. Neither of these changes what is loaded or what may be
  // corrected — they filter and fold rows already in hand.
  const [kindFilter, setKindFilter] = useState('all')      // all | sale | movement
  const [actionFilter, setActionFilter] = useState('all')  // all | edited | deleted
  // null = "only the newest day is open". A Set once the person has
  // opened or shut one themselves.
  const [openDays, setOpenDays] = useState(null)
  // Editors (storekeeper+) legitimately oversee every department, so
  // they see all of them with an "All departments" option, same as
  // Sales/Credit/Recovery. Departmental staff (bar/front_desk) should
  // only ever see their OWN assigned department(s) — not every
  // department in the branch, and not defaulted to a mixed "all of
  // mine" view when they have more than one.
  // Store sits first, straight after "All departments" (18 October
  // 2026). It was last in the row, off the end of a phone's scroll, and
  // it is the tab most often wanted here — a correction to stock is
  // nearly always a correction to the store. Everything else keeps its
  // existing order.
  const isStore = l => !!l?.is_store || /store/i.test(l?.name || '')
  const deptChips = [...(seesAllDeptChips ? (allLocations || []) : (locations || []))]
    .sort((a, b) => (isStore(a) ? 0 : 1) - (isStore(b) ? 0 : 1))
  // Reception records no sales, so defaulting the Entries subfilter to
  // it (the front desk default_location_id since migration 204) showed
  // an empty list. Prefer their first NON-Reception department —
  // Minimart for both branches' front desk — and fall back to the old
  // behaviour if Reception is genuinely all they have.
  const firstEntriesDept = (deptChips.find(l => !/reception/i.test(l.name)) || {}).id
  const [deptFilter, setDeptFilter] = useState(
    seesAllDeptChips ? 'all'
      : (firstEntriesDept || staff.default_location_id || deptChips[0]?.id || 'all'))
  // Reception tab: correcting a guest's name or stay dates. Reception
  // staff (who take the booking and so make the typos) plus gm/admin.
  // Deliberately separate from isEditor: store managers have no business
  // in guest identity records, and auditor is read-only oversight.
  const seesGuests = is(staff.role, RECEPTION_EDIT)
  // GM Office is an internal placeholder stay, not a real guest —
  // front desk has no reason to correct it and shouldn't see it.
  const seesInternalRooms = is(staff.role, SUPERVISOR)
  // Merging is gm/admin only — matches merge_guests' own is_supervisor()
  // guard, so the button never appears to someone the RPC would reject.
  const canMerge = is(staff.role, SUPERVISOR)
  const [dupes, setDupes] = useState(null)
  const [merging, setMerging] = useState(null)
  const [custDupes, setCustDupes] = useState(null)
  const [mergingCust, setMergingCust] = useState(null)
  // Manual merge: for pairs the finder cannot detect, e.g. two
  // spellings sharing no phone, initials or prefix. Moved here from
  // Settings so every merge lives in ONE place.
  const [manualMerge, setManualMerge] = useState(false)
  const [manualCust, setManualCust] = useState(false)
  const [liveStays, setLiveStays] = useState(null)
  const [guestEdit, setGuestEdit] = useState(null)
  // What moving the dates would do to the bill, fetched before it is
  // written (569). Nights come off the arrival date, so a correction
  // here is a change to what the guest owes — it should not happen
  // behind a Save button with nothing shown.
  const [stayPreview, setStayPreview] = useState(null)

  // Reset the department chip on branch switch. Holding the previous
  // branch's location id makes loadActivity query for a department
  // that doesn't exist here, so the list comes back empty with no
  // indication why — same bug already fixed on DailySales and Store.
  useEffect(() => {
    setDeptFilter(cur => (cur === 'all' || deptChips.some(l => l.id === cur))
      ? cur : (seesAllDeptChips ? 'all'
        : (firstEntriesDept || staff.default_location_id || deptChips[0]?.id || 'all')))
  }, [staff.branch_id])

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById  = useMemo(() => Object.fromEntries(allLocations.map(l => [l.id, l])), [allLocations])

  const rowLocationId = (r) => r.kind === 'sale' ? r.location_id : (r.to_location || r.from_location)
  // The figure openEdit() put in the price box, so "was" compares
  // against the same thing the form was filled from.
  const origPrice = (r) => r.kind === 'sale' ? r.unit_price : (r.unit_cost ?? null)

  // Department and search scope. Kept apart from the Sales/Stock filter
  // below so the counts on the card describe the whole scope, not
  // whichever kind happens to be selected.
  //
  // Who recorded it is searchable now that the name is loaded — "find
  // me Daniel's entries" was the first thing asked of this box and the
  // only thing it could not do.
  const scopedRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows || []).filter(r => {
      if (deptFilter !== 'all' && rowLocationId(r) !== deptFilter) return false
      if (!q) return true
      const item = (itemById[r.stock_item_id]?.name || r.description || '').toLowerCase()
      const dept = locById[rowLocationId(r)]?.name?.toLowerCase() || ''
      const date = r.business_date || ''
      const customer = r.customers?.name?.toLowerCase() || ''
      const who = (r.kind === 'sale'
        ? `${r.recorder?.full_name || ''} ${r.stood_in_for?.full_name || ''}`
        : (r.staff?.full_name || '')).toLowerCase()
      return item.includes(q) || dept.includes(q) || date.includes(q)
        || customer.includes(q) || who.includes(q)
    })
  }, [rows, query, deptFilter, itemById, locById])

  const filteredRows = useMemo(() =>
    kindFilter === 'all' ? scopedRows : scopedRows.filter(r => r.kind === kindFilter),
    [scopedRows, kindFilter])

  // ── Folding by day ────────────────────────────────────────────────
  // While a search is running every day is open: collapsing them would
  // have hidden the very rows the search found, and the page would read
  // as "nothing matches".
  const searching = !!query.trim()
  const dayOpen = (d, first) => searching || (openDays ? openDays.has(d) : d === first)
  const toggleDay = (d, first) => setOpenDays(cur => {
    const next = cur ? new Set(cur) : new Set(first ? [first] : [])
    if (next.has(d)) next.delete(d); else next.add(d)
    return next
  })
  const dayLabel = (d) =>
    d === lagosToday() ? 'Today'
    : d === lagosDaysAgo(1) ? 'Yesterday'
    : new Date(d + 'T12:00:00').toLocaleDateString('en-NG',
        { weekday: 'long', day: 'numeric', month: 'long' })
  // The Lagos calendar date of a timestamp, so a change made at 00:30
  // Lagos is not filed under the previous day by the device's clock.
  const lagosDateOf = (ts) =>
    new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  const groupBy = (list, keyOf) => {
    const m = new Map()
    for (const r of list) {
      const k = keyOf(r) || '—'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }
  const entryDays = useMemo(() => groupBy(filteredRows, r => r.business_date), [filteredRows])
  const saleCount = scopedRows.filter(r => r.kind === 'sale').length
  const moveCount = scopedRows.length - saleCount
  // Each half of the query is capped at 300 rows. Nothing said so, so a
  // busy fortnight silently stopped short of the oldest days.
  const capHit = (rows || []).filter(r => r.kind === 'sale').length >= 300
    || (rows || []).filter(r => r.kind === 'movement').length >= 300

  // Who keyed it in, by name. The page decided what you could do to a
  // row by comparing recorded_by with your own id, and never showed it.
  const whoOf = (r) => r.kind === 'sale'
    ? (r.stood_in_for?.full_name
        ? `${r.stood_in_for.full_name} (keyed by ${r.recorder?.full_name || 'unknown'})`
        : (r.recorder?.full_name || 'unknown'))
    : (r.staff?.full_name || 'unknown')
  const timeOf = (r) => r.created_at
    ? new Date(r.created_at).toLocaleTimeString('en-NG',
        { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })
    : ''
  const badgeOf = (r) => r.kind === 'sale'
    ? 'Sale' : (MOVEMENT_LABEL[r.movement_type] || r.movement_type)

  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byAction = actionFilter === 'all'
      ? (audit || [])
      : (audit || []).filter(a => (a.action === 'deleted' ? 'deleted' : 'edited') === actionFilter)
    if (!q) return byAction
    // Who made the change is searchable here too — it is the question
    // this view exists to answer.
    return byAction.filter(a =>
      a.summary?.toLowerCase().includes(q)
      || (a.business_date || '').includes(q)
      || (a.done_by_name || '').toLowerCase().includes(q))
  }, [audit, query, actionFilter])

  // Grouped by the day the CHANGE was made, which is the question this
  // view answers — not the day the entry it changed belongs to. Both
  // are shown on the row.
  //
  // MUST stay below filteredAudit: useMemo runs its function during
  // render, so reading a const declared further down throws "Cannot
  // access before initialization" and takes the whole page with it.
  // Same fault, same shape, as roomChargedToday on the Sales page.
  const auditDays = useMemo(() => groupBy(filteredAudit, a => lagosDateOf(a.happened_at)), [filteredAudit])

  const refresh = useCallback(() => {
    if (canEdit) {
      loadActivity(staff.branch_id, 14, ownOnly ? staff.id : null, deptFilter !== 'all' ? deptFilter : null)
        .then(setRows).catch(e => toast(e.message, 'error'))
    }
    // Auditors are not editors, so they are ownOnly — but the change
    // history is their core evidence. Without this they would land on the
    // history view (they can't edit) and it would never be fetched.
    if (!ownOnly || staff.role === 'auditor')
      tracked('The corrections record', loadAudit(staff.branch_id)).then(setAudit).catch(() => setAudit([]))
  }, [staff.branch_id, canEdit, ownOnly, staff.id, deptFilter])
  useEffect(refresh, [refresh])

  function describe(r) {
    const name = itemById[r.stock_item_id]?.name || r.description || 'Unknown item'
    if (r.kind === 'sale') {
      return { title: name,
        detail: `Sale · ${tierLabel[r.tier] || r.tier} · ${locById[r.location_id]?.name || ''}`
          + (r.customers?.name ? ` · customer: ${r.customers.name}` : ''),
        money: naira(r.amount ?? r.qty * r.unit_price) }
    }
    const label = MOVEMENT_LABEL[r.movement_type] || r.movement_type
    const where = r.movement_type === 'transfer'
      ? `to ${locById[r.to_location]?.name || '—'}`
      : r.movement_type === 'conversion'
      ? (locById[r.to_location || r.from_location]?.name || '—')
      : (locById[r.to_location]?.name || locById[r.from_location]?.name || 'store')
    const reasonBits = []
    if (r.movement_type === 'damage' && r.damage_reason) reasonBits.push(r.damage_reason)
    if ((r.movement_type === 'damage' || r.movement_type === 'complimentary')
        && r.note && r.note !== 'damaged' && r.note !== 'PR / complimentary') reasonBits.push(r.note)
    const reasonSuffix = reasonBits.length ? ` · ${reasonBits.join(' — ')}` : ''
    return { title: name, detail: `${label} · ${where}${r.movement_type === 'conversion' && r.note ? ` · ${r.note}` : ''}${reasonSuffix}`,
             money: r.unit_cost ? naira(r.qty * r.unit_cost) : '' }
  }

  async function openEdit(r) {
    const base = { row: r, qty: r.qty, date: r.business_date || '',
      price: r.kind === 'sale' ? r.unit_price : (r.unit_cost ?? ''), payments: null }
    if (r.kind === 'sale') {
      try {
        const pays = await loadSalePayments(r.id)
        // keep the split intact instead of collapsing it to one method
        base.payments = Object.fromEntries(
          methods.map(m => [m, String(pays.find(p => p.method === m)?.amount ?? '')]))
        base.wasSplit = pays.length > 1
      } catch (e) { toast(e.message, 'error') }
    }
    setEdit(base)
  }

  async function doDelete() {
    setBusy(true)
    try {
      await deleteEntry(confirm)
      toast('Entry deleted', 'success'); setConfirm(null); refresh()
    } catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setBusy(false)
  }

  async function doSave() {
    setBusy(true)
    try {
      const qty = Number(edit.qty)
      const unitPrice = edit.price === '' ? null : Number(edit.price)
      if (edit.row.kind === 'sale') {
        const payments = methods.map(m => ({ method: m, amount: Number(edit.payments?.[m] || 0) }))
        const entered = payments.reduce((s, p) => s + p.amount, 0)
        if (Math.abs(entered - qty * unitPrice) > 0.01) {
          toast('Payments must add up to ' + naira(qty * unitPrice), 'error'); setBusy(false); return
        }
        await updateSaleWithPayments(edit.row.id, { qty, unitPrice, payments,
          businessDate: edit.date && edit.date !== edit.row.business_date ? edit.date : null })
      } else {
        await updateEntry({ ...edit.row, branch_id: staff.branch_id }, { qty, unitPrice })
      }
      toast('Entry updated', 'success'); setEdit(null); refresh()
    } catch (e) { toast('Not updated: ' + e.message, 'error') }
    setBusy(false)
  }

  const refreshGuests = useCallback(() => {
    if (!seesGuests) return
    loadLiveStays(staff.branch_id).then(setLiveStays).catch(e => toast(e.message, 'error'))
  }, [seesGuests, staff.branch_id, toast])

  useEffect(() => { if (view === 'guests') refreshGuests() }, [view, refreshGuests])

  const refreshDupes = useCallback(() => {
    if (!canMerge) return
    tracked('Guests entered twice', findDuplicateGuests(staff.branch_id)).then(setDupes).catch(() => setDupes([]))
  }, [canMerge, staff.branch_id])
  useEffect(() => { if (view === 'guests') refreshDupes() }, [view, refreshDupes])

  const refreshCustDupes = useCallback(() => {
    if (!canMerge) return
    tracked('Customers entered twice', findDuplicateCustomers(staff.branch_id)).then(setCustDupes).catch(() => setCustDupes([]))
  }, [canMerge, staff.branch_id])
  useEffect(() => { if (view === 'guests') refreshCustDupes() }, [view, refreshCustDupes])

  async function doMergeCustomers() {
    setBusy(true)
    try {
      await mergeCustomers(mergingCust.survivorId, [mergingCust.dupId])
      toast('Customer records merged', 'success')
      setMergingCust(null)
      refreshCustDupes()
    } catch (e) { toast('Not merged: ' + e.message, 'error') }
    setBusy(false)
  }

  async function doMerge() {
    setBusy(true)
    try {
      await mergeGuests(merging.survivorId, [merging.dupId])
      toast('Guest records merged', 'success')
      setMerging(null)
      refreshDupes(); refreshGuests()
    } catch (e) { toast('Not merged: ' + e.message, 'error') }
    setBusy(false)
  }

  const visibleStays = (liveStays || [])
    .filter(s2 => seesInternalRooms || !s2.rooms?.is_internal)

  // Whether anything about the STAY moved, as opposed to the guest's
  // name or phone, which belong to the person rather than this visit.
  const stayMoved = (g) => !!g && (g.checkIn !== g.origCheckIn
    || g.scheduledOut !== g.origScheduledOut
    || (g.time || '') !== (g.origTime || ''))

  async function saveGuestEdit() {
    const g = guestEdit
    // Dates moved and the figures have not been read yet: fetch them and
    // stop. The second tap is the one that writes.
    if (stayMoved(g) && !stayPreview) {
      setBusy(true)
      try {
        setStayPreview(await correctStay({
          stayId: g.stayId, checkIn: g.checkIn, scheduledOut: g.scheduledOut,
          time: g.time, preview: true,
        }))
      } catch (e) { toast(friendlyStayError(e) || e.message, 'error') }
      setBusy(false)
      return
    }
    setBusy(true)
    try {
      if (g.fullName.trim() !== g.origName || (g.phone || '') !== (g.origPhone || '')) {
        await updateGuestIdentity(g.guestId, { fullName: g.fullName.trim(), phone: g.phone })
      }
      if (stayMoved(g)) {
        await correctStay({
          stayId: g.stayId, checkIn: g.checkIn, scheduledOut: g.scheduledOut,
          time: g.time, reason: g.reason,
        })
      }
      toast('Correction saved', 'success')
      setGuestEdit(null); setStayPreview(null)
      refreshGuests()
    } catch (e) { toast(friendlyStayError(e) || e.message, 'error') }
    setBusy(false)
  }

  if (canEdit && !rows) return <p className="px-5 text-dim">Loading…</p>

  return (
    <div className="px-5">
      {/* The bar used to appear only for full editors. Reception staff
          are ownOnly, so without the seesGuests clause below the very
          people this tab exists for could never reach it. Change
          history stays gated on !ownOnly exactly as before — adding
          the Reception tab must not quietly hand front desk a view
          they were never meant to have. */}
      {canEdit && (!ownOnly || seesGuests) && <div className="flex gap-2 py-2">
        {[...(seesGuests && landsOnReception ? [['guests', 'Reception']] : []),
          ['entries', 'Entries'],
          ...(seesGuests && !landsOnReception ? [['guests', 'Reception']] : []),
          ...(!ownOnly ? [['history', 'History']] : [])].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex-1 h-12 rounded-xl border font-bold ${view === k
              ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>}

      {!canEdit && (
        <p className="text-dim text-sm py-2">
          Every edit and deletion at this branch, newest first.
        </p>
      )}

      <input value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Search by item, person, customer, department, or date (YYYY-MM-DD)"
        className="w-full h-12 px-4 mt-1 mb-2 rounded-xl bg-surface border border-line placeholder:text-dim" />

      {view !== 'history' && deptChips.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
          {seesAllDeptChips && (
            <button onClick={() => { setDeptFilter('all'); if (view === 'guests') setView('entries') }}
              className={`shrink-0 h-9 px-3 rounded-full border text-sm ${view !== 'guests' && deptFilter === 'all'
                ? 'bg-raise border-amber text-amber font-bold' : 'border-line text-dim'}`}>
              All departments
            </button>
          )}
          {deptChips.map(l => (
            <button key={l.id}
              onClick={() => {
                setDeptFilter(l.id)
                // On the Reception tab the chips would otherwise be
                // inert — the guest list isn't department-scoped.
                // Tapping Minimart there means "show me Minimart",
                // so send them to Entries filtered to it.
                if (view === 'guests') setView('entries')
              }}
              className={`shrink-0 h-9 px-3 rounded-full border text-sm ${view !== 'guests' && deptFilter === l.id
                ? 'bg-raise border-amber text-amber font-bold' : 'border-line text-dim'}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}

      {view === 'guests' && seesGuests ? (
        <>
          <p className="text-dim text-sm py-2">
            Everyone currently checked in or booked in. Fixing a name here
            updates that guest everywhere, including past stays.
          </p>
          {liveStays === null && <p className="text-dim">Loading…</p>}
          {liveStays !== null && !visibleStays.length && (
            <p className="py-8 text-center text-dim">No live guests right now.</p>
          )}
          <ul className="divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
            {visibleStays.map(s2 => (
              <li key={s2.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="truncate font-semibold">
                    {s2.guests?.full_name || 'Guest'}
                  </div>
                  <div className="text-dim text-sm tnum">
                    Room {s2.rooms?.room_number || '—'} · {s2.check_in_date} to {s2.scheduled_out}
                    {s2.status === 'reserved' && ' · reserved'}
                  </div>
                </div>
                <button
                  onClick={() => setGuestEdit({
                    stayId: s2.id, guestId: s2.guests?.id,
                    fullName: s2.guests?.full_name || '', origName: s2.guests?.full_name || '',
                    phone: s2.guests?.phone || '', origPhone: s2.guests?.phone || '',
                    checkIn: s2.check_in_date, origCheckIn: s2.check_in_date,
                    scheduledOut: s2.scheduled_out, origScheduledOut: s2.scheduled_out,
                    time: lagosHHMM(s2.checked_in_at), origTime: lagosHHMM(s2.checked_in_at),
                    reason: '',
                    room: s2.rooms?.room_number,
                  })}
                  className="shrink-0 h-10 px-4 rounded-xl border border-amber text-amber font-semibold text-sm">
                  Edit
                </button>
              </li>
            ))}
          </ul>
          {canMerge && !!dupes?.length && (
            <Notice tone="warn" title="Possible duplicate guests" className="mt-4">
              <p className="mb-3">
                Same person entered twice. Check each one — a shared phone can
                also just mean two people in one family. Merging moves every
                stay, room charge and department balance onto the record you keep.
                If they are two different people, say so and the pair stops being
                flagged.
              </p>
              {dupes.map((d, i) => (
                <div key={i} className="py-2 border-t border-line/60 first:border-0">
                  <div className="text-xs text-dim mb-1">{d.reason}</div>
                  <div className="flex items-center gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{d.name_a}
                        <span className="text-dim"> · {d.stays_a} stay{d.stays_a === 1 ? '' : 's'}</span>
                      </div>
                      <div className="truncate">{d.name_b}
                        <span className="text-dim"> · {d.stays_b} stay{d.stays_b === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    {/* Default to keeping whichever has more history, but
                        let the user pick either — the shorter name is not
                        always the wrong one. */}
                    <button
                      onClick={() => setMerging({
                        survivorId: d.guest_a, survivorName: d.name_a,
                        dupId: d.guest_b, dupName: d.name_b })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_a}"
                    </button>
                    <button
                      onClick={() => setMerging({
                        survivorId: d.guest_b, survivorName: d.name_b,
                        dupId: d.guest_a, dupName: d.name_a })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_b}"
                    </button>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await dismissDuplicatePair('guest', d.guest_a, d.guest_b)
                        setDupes(list => list.filter(x => x !== d))
                        toast('Noted — two different people', 'success')
                      } catch (e) { toast(e.message, 'error') }
                    }}
                    className="mt-2 w-full h-9 rounded-lg border border-line/60 text-dim text-xs">
                    Not the same person
                  </button>
                </div>
              ))}
            </Notice>
          )}
          {canMerge && dupes?.length === 0 && (
            <p className="text-dim text-sm mt-4">No likely duplicate guests found.</p>
          )}
          {canMerge && (
            <button onClick={() => setManualMerge(true)}
              className="mt-3 w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
              Merge two guests not listed above
            </button>
          )}
          {canMerge && !!custDupes?.length && (
            <Notice tone="warn" title="Possible duplicate customers" className="mt-4">
              <p className="mb-3">
                Credit accounts at the bars, minimart and restaurant. Balance and
                departments are shown so you can see which record holds the real
                history before choosing. Merging moves every sale and repayment
                onto the record you keep.
              </p>
              {custDupes.map((d, i) => (
                <div key={i} className="py-2 border-t border-line/60 first:border-0">
                  <div className="text-xs text-dim mb-1">{d.reason}</div>
                  <div className="text-sm">
                    <div className="truncate">
                      {d.name_a}
                      <span className="text-dim"> · {naira(d.bal_a)} · {d.depts_a}</span>
                    </div>
                    <div className="truncate">
                      {d.name_b}
                      <span className="text-dim"> · {naira(d.bal_b)} · {d.depts_b}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setMergingCust({
                        survivorId: d.cust_a, survivorName: d.name_a, survivorBal: d.bal_a,
                        dupId: d.cust_b, dupName: d.name_b, dupBal: d.bal_b })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_a}"
                    </button>
                    <button
                      onClick={() => setMergingCust({
                        survivorId: d.cust_b, survivorName: d.name_b, survivorBal: d.bal_b,
                        dupId: d.cust_a, dupName: d.name_a, dupBal: d.bal_a })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_b}"
                    </button>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await dismissDuplicatePair('customer', d.cust_a, d.cust_b)
                        setCustDupes(list => list.filter(x => x !== d))
                        toast('Noted — two different accounts', 'success')
                      } catch (e) { toast(e.message, 'error') }
                    }}
                    className="mt-2 w-full h-9 rounded-lg border border-line/60 text-dim text-xs">
                    Not the same account
                  </button>
                </div>
              ))}
            </Notice>
          )}
          {canMerge && custDupes?.length === 0 && (
            <p className="text-dim text-sm mt-4">No likely duplicate customers found.</p>
          )}
          {canMerge && (
            <button onClick={() => setManualCust(true)}
              className="mt-3 w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
              Merge two credit accounts not listed above
            </button>
          )}
        </>
      ) : view === 'history' ? (
        <>
        {/* The record of who changed what. It said "every edit and
            deletion at this branch" and showed the newest hundred —
            true of the query, not of the sentence. It says so now, and
            counts what it is holding (18 October 2026). */}
        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="text-dim text-sm">Changes to records at this branch</div>
          <div className="tnum text-2xl font-bold">
            {filteredAudit.length} {filteredAudit.length === 1 ? 'change' : 'changes'}
          </div>
          {!!audit?.length && (
            <div className="text-dim text-sm mt-1">
              {audit.filter(a => a.action !== 'deleted').length} edited ·{' '}
              <span className={audit.filter(a => a.action === 'deleted').length ? 'text-clay' : ''}>
                {audit.filter(a => a.action === 'deleted').length} deleted
              </span>
              {audit.length >= 100 && <span className="text-amber"> · newest 100 only</span>}
            </div>
          )}
          <p className="text-dim text-xs mt-2 pt-2 border-t border-line">
            Nothing here can be altered. An entry that was deleted still shows what it
            was and who removed it.
          </p>
        </section>

        <div className="flex gap-2 mt-3">
          {[['all', 'All'], ['edited', 'Edits'], ['deleted', 'Deletions']].map(([k, label]) => (
            <button key={k} onClick={() => setActionFilter(k)}
              className={`flex-1 h-10 rounded-xl border text-sm font-semibold ${actionFilter === k
                ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
              {label}
            </button>
          ))}
        </div>

        {auditDays.map(([day, dayRows]) => {
          const first = auditDays[0][0]
          const dels = dayRows.filter(a => a.action === 'deleted').length
          return (
            <DayGroup key={day} label={dayLabel(day)}
              sub={`${dayRows.length} ${dayRows.length === 1 ? 'change' : 'changes'}`}
              right={dels > 0
                ? <span className="text-clay text-sm font-semibold">{dels} deleted</span>
                : null}
              open={dayOpen(day, first)} onToggle={() => toggleDay(day, first)}>
              <ul className="divide-y divide-line/60">
                {dayRows.map(a => (
                  <li key={a.id} className="py-3">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xs font-bold rounded-full px-2 py-0.5 border shrink-0 ${
                        a.action === 'deleted' ? 'border-clay text-clay' : 'border-amber text-amber'}`}>
                        {a.action === 'deleted' ? 'Deleted' : 'Edited'}
                      </span>
                      {a.entity && <span className="text-dim text-xs shrink-0">{a.entity}</span>}
                      <span className="flex-1" />
                      <span className="tnum text-dim text-xs shrink-0">
                        {new Date(a.happened_at).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos',
                          hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="mt-1 break-words">{a.summary}</p>
                    <p className="text-dim text-sm mt-0.5">
                      by {a.done_by_name || 'unknown'}
                      {a.business_date && <span> · entry dated {a.business_date}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            </DayGroup>
          )
        })}

        {audit && !filteredAudit.length && (
          <p className="py-8 text-center text-dim">
            {!audit.length ? 'Nothing has been changed or deleted yet.'
              : searching ? `Nothing matches “${query.trim()}”.`
              : actionFilter === 'deleted' ? 'Nothing has been deleted.'
              : 'Nothing has been edited.'}
          </p>
        )}
        {!audit && <p className="py-8 text-center text-dim">Loading…</p>}
        </>
      ) : (
      <>
      {/* What this list is, before the list (18 October 2026). The page
          opened on one grey sentence and then several hundred identical
          rows: no count, no sense of how far back it really reached,
          and nothing saying the query stops at 300 of each kind. */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="text-dim text-sm">
          {ownOnly ? 'Your own entries · last 7 days' : 'Last 14 days'}
          {deptFilter !== 'all' && locById[deptFilter]
            ? ` · ${locById[deptFilter].name}`
            : ' · all departments'}
        </div>
        <div className="tnum text-2xl font-bold">
          {filteredRows.length} {filteredRows.length === 1 ? 'entry' : 'entries'}
        </div>
        <div className="text-dim text-sm mt-1">
          {saleCount} {saleCount === 1 ? 'sale' : 'sales'} · {moveCount} stock{' '}
          {moveCount === 1 ? 'movement' : 'movements'}
          {capHit && <span className="text-amber"> · newest 300 of each kind</span>}
        </div>
        <p className="text-dim text-xs mt-2 pt-2 border-t border-line">
          {ownOnly
            ? 'You can correct these yourself. Ask a manager if something needs removing.'
            : 'Deleting a sale also reverses its stock deduction. Every edit and deletion is kept under History.'}
        </p>
      </section>

      {/* A correction is nearly always to one or the other, and the two
          were shuffled together in one stream. */}
      <div className="flex gap-2 mt-3">
        {[['all', 'All'], ['sale', 'Sales'], ['movement', 'Stock']].map(([k, label]) => (
          <button key={k} onClick={() => setKindFilter(k)}
            className={`flex-1 h-10 rounded-xl border text-sm font-semibold ${kindFilter === k
              ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
            {label}
          </button>
        ))}
      </div>

      {entryDays.map(([day, dayRows]) => {
        const first = entryDays[0][0]
        const money = dayRows.reduce((t, r) => t + (r.kind === 'sale'
          ? Number(r.amount ?? r.qty * r.unit_price ?? 0) : 0), 0)
        return (
          <DayGroup key={day} label={dayLabel(day)}
            sub={`${dayRows.length} ${dayRows.length === 1 ? 'entry' : 'entries'}`}
            right={money > 0 ? <span className="tnum font-semibold">{naira(money)}</span> : null}
            open={dayOpen(day, first)} onToggle={() => toggleDay(day, first)}>
            <ul className="divide-y divide-line/60">
              {dayRows.map(r => {
                const d = describe(r)
                return (
                  <li key={`${r.kind}:${r.id}`} className="py-3">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 min-w-0 font-semibold break-words">{d.title}</span>
                      {/* The kind, as a word rather than buried in the
                          middle of a grey sentence. A damage write-off
                          and a sale looked identical at a glance. */}
                      <span className={`shrink-0 text-xs font-bold rounded-full px-2 py-0.5 border ${
                        r.kind === 'sale' ? 'border-line text-dim'
                        : r.movement_type === 'damage' ? 'border-clay text-clay'
                        : 'border-amber text-amber'}`}>
                        {badgeOf(r)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex-1 min-w-0 text-dim text-sm break-words">{d.detail}</span>
                      <span className="tnum shrink-0">{r.qty}</span>
                      {d.money && <span className="tnum text-dim shrink-0">{d.money}</span>}
                    </div>
                    {/* Who keyed it and when. Without a name, every
                        judgement about whether a row should be touched
                        was guesswork — and two entries of the same item
                        on the same day could not be told apart at all. */}
                    <div className="text-dim text-xs mt-0.5">
                      {timeOf(r) && <span className="tnum">{timeOf(r)} · </span>}
                      by {whoOf(r)}
                    </div>
                    <div className="flex gap-2 mt-2">
                      {(isEditor || (canCorrectSales && r.kind === 'sale')
                        || (r.recorded_by === staff.id && r.business_date >= lagosDaysAgo(6))) && (
                        <button onClick={() => openEdit(r)}
                          className="h-10 px-4 rounded-lg border border-line text-sm font-semibold">Edit</button>
                      )}
                      {!isEditor && r.recorded_by === staff.id && r.business_date < lagosDaysAgo(6) && (
                        <span className="text-dim text-sm self-center">
                          Too old to edit yourself — ask a manager
                        </span>
                      )}
                      {(canDeleteAny || (isStorekeeper && r.kind !== 'sale'
                          && r.recorded_by === staff.id && r.business_date >= lagosDaysAgo(1))) && (
                        <button onClick={() => setConfirm(r)}
                          className="h-10 px-4 rounded-lg border border-clay text-clay text-sm font-semibold">Delete</button>
                      )}
                      {r.on_behalf_of && r.recorded_by !== staff.id && (
                        <span className="text-dim text-sm self-center">
                          Recorded on your behalf — ask a manager to correct it
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </DayGroup>
        )
      })}

      {!filteredRows.length && (
        <p className="py-8 text-center text-dim">
          {!rows.length ? (ownOnly ? 'You have no entries in the last 7 days.' : 'No entries in the last 14 days.')
            : searching ? `Nothing matches “${query.trim()}”.`
            : kindFilter === 'sale' ? 'No sales here in this period.'
            : kindFilter === 'movement' ? 'No stock movements here in this period.'
            : 'Nothing to show.'}
        </p>
      )}
      </>
      )}

      {edit && (
        <Sheet onClose={() => setEdit(null)}>
          <h2 className="text-2xl font-bold">{describe(edit.row).title}</h2>
          <p className="text-dim mt-1">{describe(edit.row).detail}</p>
          {/* Date first: a sale on the wrong day was previously stuck
              there — edit_sale did not accept a date at all. Only shown
              to those the database will actually allow to change one. */}
          {canChangeDate && edit.row.kind === 'sale' && (
            <>
              <label className="block mt-6 text-dim">Date of sale</label>
              <input type="date" value={edit.date} max={lagosToday()}
                onChange={e => setEdit({ ...edit, date: e.target.value })}
                className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />
              {edit.date !== edit.row.business_date && (
                <p className="text-amber text-sm mt-1">
                  Moving this sale from {edit.row.business_date} to {edit.date}. It will leave
                  that day's takings and join this one.
                </p>
              )}
            </>
          )}

          {/* What it was, next to what it is becoming. The date field
              has always named the move it was making; quantity and
              price — the two that change money — were typed over in
              silence, so a mistyped correction looked exactly like a
              correct one (18 October 2026). */}
          <label className="block mt-6 text-dim">Quantity</label>
          <input type="number" inputMode="decimal" value={edit.qty}
            onChange={e => setEdit({ ...edit, qty: e.target.value })}
            className={`mt-2 h-14 w-full px-4 rounded-xl bg-surface border tnum ${
              String(edit.qty) !== String(edit.row.qty) ? 'border-amber' : 'border-line'}`} />
          {String(edit.qty) !== String(edit.row.qty) && (
            <p className="text-amber text-sm mt-1 tnum">Was {edit.row.qty}</p>
          )}
          <label className="block mt-4 text-dim">
            {edit.row.kind === 'sale' ? 'Unit price' : 'Unit cost (optional)'}
          </label>
          <input type="number" inputMode="decimal" value={edit.price}
            onChange={e => setEdit({ ...edit, price: e.target.value })}
            className={`mt-2 h-14 w-full px-4 rounded-xl bg-surface border tnum ${
              String(edit.price) !== String(origPrice(edit.row) ?? '') ? 'border-amber' : 'border-line'}`} />
          {String(edit.price) !== String(origPrice(edit.row) ?? '') && (
            <p className="text-amber text-sm mt-1 tnum">
              Was {origPrice(edit.row) == null ? 'blank' : naira(origPrice(edit.row))}
            </p>
          )}

          {/* The line's own total, before and after. The payments box
              below already demands a figure to match; this is where
              that figure comes from. */}
          {(() => {
            const wasTotal = Number(edit.row.kind === 'sale'
              ? (edit.row.amount ?? edit.row.qty * edit.row.unit_price)
              : edit.row.qty * (edit.row.unit_cost || 0))
            const nowTotal = Number(edit.qty || 0) * Number(edit.price || 0)
            if (!wasTotal && !nowTotal) return null
            const moved = Math.abs(nowTotal - wasTotal) > 0.009
            return (
              <div className="mt-4 rounded-xl border border-line bg-raise px-4 py-3">
                <div className="flex justify-between gap-3">
                  <span className="text-dim text-sm">Line total</span>
                  <span className="tnum font-bold">{naira(nowTotal)}</span>
                </div>
                {moved && (
                  <div className="flex justify-between gap-3 mt-1">
                    <span className="text-amber text-sm">Was</span>
                    <span className="tnum text-amber text-sm">{naira(wasTotal)}</span>
                  </div>
                )}
              </div>
            )
          })()}
          {edit.row.kind === 'sale' && edit.payments && (
            <div className="mt-5">
              <div className="text-dim mb-2">
                How it was paid{edit.wasSplit ? ' (split preserved)' : ''}
              </div>
              {methods.map(m => (
                <div key={m} className="flex items-center gap-3 mt-2">
                  <span className="w-20 text-dim">{methodLabel[m] || m}</span>
                  <input type="number" inputMode="decimal" placeholder="0"
                    value={edit.payments[m]}
                    onChange={e => setEdit(x => ({ ...x,
                      payments: { ...x.payments, [m]: e.target.value } }))}
                    className="h-12 flex-1 px-3 rounded-xl bg-surface border border-line tnum" />
                </div>
              ))}
              <p className="text-dim text-sm mt-2">
                Must total {naira(Number(edit.qty) * Number(edit.price || 0))}
              </p>
            </div>
          )}
          <button onClick={doSave} disabled={busy}
            className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </Sheet>
      )}

      {manualMerge && (
        <MergeGuestsSheet boot={boot}
          onClose={() => { setManualMerge(false); refreshDupes(); refreshGuests() }} />
      )}

      {manualCust && (
        <MergeCustomersSheet boot={boot}
          onClose={() => { setManualCust(false); refreshCustDupes() }} />
      )}

      {mergingCust && (
        <Sheet onClose={() => setMergingCust(null)}>
          <h3 className="text-xl font-bold">Merge customer records</h3>
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim text-sm">Keeping</div>
            <div className="font-semibold">{mergingCust.survivorName}</div>
            <div className="text-dim text-sm tnum">{naira(mergingCust.survivorBal)} owing</div>
            <div className="text-dim text-sm mt-3">Merging in and closing</div>
            <div className="font-semibold text-clay">{mergingCust.dupName}</div>
            <div className="text-dim text-sm tnum">{naira(mergingCust.dupBal)} owing</div>
          </div>
          <div className="mt-4 rounded-2xl border border-amber bg-surface p-4">
            <div className="text-dim text-sm">Combined balance afterwards</div>
            <div className="tnum text-xl font-bold text-clay">
              {naira(Number(mergingCust.survivorBal) + Number(mergingCust.dupBal))}
            </div>
          </div>
          <p className="text-dim text-sm mt-4">
            Every sale and repayment under "{mergingCust.dupName}" moves onto
            "{mergingCust.survivorName}". The old account is closed and renamed,
            not deleted, so receipts already issued still resolve.
          </p>
          <p className="text-clay text-sm mt-3">
            This moves real money between accounts. Be sure they are the same
            person — two people can share a phone.
          </p>
          <button onClick={doMergeCustomers} disabled={busy}
            className="mt-5 h-12 w-full rounded-xl bg-clay text-bg font-bold disabled:opacity-40">
            {busy ? 'Merging…' : `Merge into ${mergingCust.survivorName}`}
          </button>
          <button onClick={() => setMergingCust(null)}
            className="mt-2 h-12 w-full rounded-xl border border-line text-dim font-semibold">
            Cancel
          </button>
        </Sheet>
      )}

      {merging && (
        <Sheet onClose={() => setMerging(null)}>
          <h3 className="text-xl font-bold">Merge guest records</h3>
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim text-sm">Keeping</div>
            <div className="font-semibold">{merging.survivorName}</div>
            <div className="text-dim text-sm mt-3">Merging in and closing</div>
            <div className="font-semibold text-clay">{merging.dupName}</div>
          </div>
          <p className="text-dim text-sm mt-4">
            Every stay, bill-to reference and department balance belonging to
            "{merging.dupName}" moves onto "{merging.survivorName}". The old
            record is kept but renamed, so the history is auditable rather than
            erased — it is not deleted.
          </p>
          <p className="text-clay text-sm mt-3">
            Make sure these really are the same person. Undoing a merge means
            editing records by hand.
          </p>
          <button onClick={doMerge} disabled={busy}
            className="mt-5 h-12 w-full rounded-xl bg-clay text-bg font-bold disabled:opacity-40">
            {busy ? 'Merging…' : `Merge into ${merging.survivorName}`}
          </button>
          <button onClick={() => setMerging(null)}
            className="mt-2 h-12 w-full rounded-xl border border-line text-dim font-semibold">
            Cancel
          </button>
        </Sheet>
      )}

      {guestEdit && (
        <Sheet onClose={() => { setGuestEdit(null); setStayPreview(null) }}>
          <h3 className="text-xl font-bold">Correct guest details</h3>
          <p className="text-dim text-sm mt-1 mb-4">
            Room {guestEdit.room || '—'}. The name and phone belong to the guest
            record, so they change on every stay of theirs, past and future. The
            dates apply to this stay only.
          </p>

          <div className="text-dim text-sm mb-1">Guest name</div>
          <input value={guestEdit.fullName} autoComplete="off"
            onChange={e => setGuestEdit(g => ({ ...g, fullName: e.target.value }))}
            className="h-12 w-full px-3 rounded-xl bg-raise border border-line" />

          <div className="text-dim text-sm mt-3 mb-1">Phone</div>
          <input value={guestEdit.phone} inputMode="tel" autoComplete="off"
            onChange={e => setGuestEdit(g => ({ ...g, phone: e.target.value }))}
            className="h-12 w-full px-3 rounded-xl bg-raise border border-line tnum" />

          <div className="text-dim text-sm mt-3 mb-1">Check-in date</div>
          <input type="date" value={guestEdit.checkIn}
            onChange={e => { setStayPreview(null); setGuestEdit(g => ({ ...g, checkIn: e.target.value })) }}
            className="h-12 px-3 rounded-xl bg-raise border border-line tnum" />

          <div className="text-dim text-sm mt-3 mb-1">Scheduled check-out</div>
          <input type="date" value={guestEdit.scheduledOut} min={guestEdit.checkIn}
            onChange={e => { setStayPreview(null); setGuestEdit(g => ({ ...g, scheduledOut: e.target.value })) }}
            className="h-12 px-3 rounded-xl bg-raise border border-line tnum" />

          <div className="text-dim text-sm mt-3 mb-1">Arrival time</div>
          <input type="time" value={guestEdit.time || ''}
            onChange={e => { setStayPreview(null); setGuestEdit(g => ({ ...g, time: e.target.value })) }}
            className="h-12 px-3 rounded-xl bg-raise border border-line tnum" />
          <p className="text-dim text-xs mt-1">
            Only the clock time. Moving it does not change what is charged.
          </p>

          {stayMoved(guestEdit) && (
            <>
              <div className="text-dim text-sm mt-3 mb-1">Why</div>
              <input value={guestEdit.reason || ''}
                onChange={e => setGuestEdit(g => ({ ...g, reason: e.target.value }))}
                placeholder="Keyed the wrong arrival day"
                className="h-12 w-full px-3 rounded-xl bg-raise border border-line placeholder:text-dim" />
              <p className="text-dim text-xs mt-1">
                Goes on the record with your name, beside the change itself.
              </p>
            </>
          )}

          {/* What it does to the money, read BEFORE it is written (569).
              Nights come off the arrival date, so moving it moves the
              bill — and the old screen moved it silently. */}
          {stayPreview && (
            <Notice tone={Math.abs(Number(stayPreview.difference)) > 0.009 ? 'warn' : 'note'}
              title={Math.abs(Number(stayPreview.difference)) > 0.009
                ? 'This changes what the guest owes'
                : 'This does not change the bill'}
              className="mt-4">
              <div className="space-y-1">
                <div className="flex justify-between gap-3">
                  <span>Nights</span>
                  <span className="tnum shrink-0">
                    {stayPreview.nights_now} → <b>{stayPreview.nights_after}</b>
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>Room charge</span>
                  <span className="tnum shrink-0">
                    {naira(stayPreview.room_charge_now)} → <b>{naira(stayPreview.room_charge_after)}</b>
                  </span>
                </div>
                {Math.abs(Number(stayPreview.difference)) > 0.009 && (
                  <div className="flex justify-between gap-3 pt-1 border-t border-line/60">
                    <span>Difference</span>
                    <span className={`tnum font-bold shrink-0 ${
                      Number(stayPreview.difference) > 0 ? 'text-clay' : 'text-leaf'}`}>
                      {Number(stayPreview.difference) > 0 ? '+' : '−'}
                      {naira(Math.abs(Number(stayPreview.difference)))}
                    </span>
                  </div>
                )}
              </div>
            </Notice>
          )}

          <p className="text-dim text-xs mt-3">
            Moving the dates is checked against the room's other bookings. If it
            would put this guest on top of another, the save is refused and
            nothing changes.
          </p>

          <button onClick={saveGuestEdit}
            disabled={busy || !guestEdit.fullName.trim() || !guestEdit.checkIn || !guestEdit.scheduledOut
                      || (stayMoved(guestEdit) && !!stayPreview && !guestEdit.reason?.trim())}
            className="mt-5 h-12 w-full rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
            {busy ? 'Saving…'
              : stayMoved(guestEdit) && !stayPreview ? 'Check what this changes'
              : 'Save correction'}
          </button>
        </Sheet>
      )}

      {confirm && (
        <Sheet onClose={() => setConfirm(null)}>
          <h2 className="text-2xl font-bold">Delete this entry?</h2>
          <p className="mt-2 font-semibold">{describe(confirm).title}</p>
          <p className="text-dim mt-1">
            {describe(confirm).detail} · {confirm.qty}
            {describe(confirm).money ? ` · ${describe(confirm).money}` : ''}
          </p>
          {/* Whose entry, and when they keyed it. Deleting someone
              else's record without being told whose it is was how a
              correction became an argument. */}
          <p className="text-dim text-sm mt-1">
            Recorded by {whoOf(confirm)}
            {timeOf(confirm) && <span className="tnum"> at {timeOf(confirm)}</span>}
            {confirm.business_date && <span className="tnum"> on {confirm.business_date}</span>}
          </p>
          <p className="text-clay mt-3">This cannot be undone. Stock returns to what it was.</p>
          <button onClick={doDelete} disabled={busy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
          <button onClick={() => setConfirm(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </Sheet>
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
