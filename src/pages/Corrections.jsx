import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, tierLabel, methodLabel, lagosDaysAgo, friendlyStayError } from '../lib/format'
import { loadActivity, deleteEntry, updateEntry, loadAudit,
         loadSalePayments, updateSaleWithPayments,
         loadLiveStays, updateGuestIdentity, correctStayDates,
         findDuplicateGuests, mergeGuests,
         findDuplicateCustomers, mergeCustomers } from '../lib/data'
import { useToast } from '../components/Toast'
import MergeGuestsSheet from '../components/MergeGuestsSheet'
import { MANAGEMENT, RECEPTION_EDIT, SUPERVISOR, is } from '../lib/roles'

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
  const canEdit = isEditor || isStorekeeper || staff.role === 'bar' || staff.role === 'front_desk'
  const ownOnly = !isEditor
  // Store managers keep the all-departments chips (a filter over their
  // own rows), so an entry they made at another counter is never hidden.
  const seesAllDeptChips = isEditor || isStorekeeper
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
  // Editors (storekeeper+) legitimately oversee every department, so
  // they see all of them with an "All departments" option, same as
  // Sales/Credit/Recovery. Departmental staff (bar/front_desk) should
  // only ever see their OWN assigned department(s) — not every
  // department in the branch, and not defaulted to a mixed "all of
  // mine" view when they have more than one.
  const deptChips = seesAllDeptChips ? allLocations : (locations || [])
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
  const [liveStays, setLiveStays] = useState(null)
  const [guestEdit, setGuestEdit] = useState(null)

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

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows || []).filter(r => {
      if (deptFilter !== 'all' && rowLocationId(r) !== deptFilter) return false
      if (!q) return true
      const item = (itemById[r.stock_item_id]?.name || r.description || '').toLowerCase()
      const dept = locById[rowLocationId(r)]?.name?.toLowerCase() || ''
      const date = r.business_date || ''
      const customer = r.customers?.name?.toLowerCase() || ''
      return item.includes(q) || dept.includes(q) || date.includes(q) || customer.includes(q)
    })
  }, [rows, query, deptFilter, itemById, locById])

  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return audit || []
    return (audit || []).filter(a =>
      a.summary?.toLowerCase().includes(q) || (a.business_date || '').includes(q))
  }, [audit, query])

  const refresh = useCallback(() => {
    if (canEdit) {
      loadActivity(staff.branch_id, 14, ownOnly ? staff.id : null, deptFilter !== 'all' ? deptFilter : null)
        .then(setRows).catch(e => toast(e.message, 'error'))
    }
    // Auditors are not editors, so they are ownOnly — but the change
    // history is their core evidence. Without this they would land on the
    // history view (they can't edit) and it would never be fetched.
    if (!ownOnly || staff.role === 'auditor')
      loadAudit(staff.branch_id).then(setAudit).catch(() => setAudit([]))
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
    const label = { restock: 'Received', transfer: 'Disbursed', issue: 'Issued',
                    damage: 'Damaged', complimentary: 'PR / free', adjustment: 'Adjustment',
                    opening: 'Opening', conversion: 'Converted' }[r.movement_type] || r.movement_type
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
    const base = { row: r, qty: r.qty,
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
        await updateSaleWithPayments(edit.row.id, { qty, unitPrice, payments })
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
    findDuplicateGuests(staff.branch_id).then(setDupes).catch(() => setDupes([]))
  }, [canMerge, staff.branch_id])
  useEffect(() => { if (view === 'guests') refreshDupes() }, [view, refreshDupes])

  const refreshCustDupes = useCallback(() => {
    if (!canMerge) return
    findDuplicateCustomers(staff.branch_id).then(setCustDupes).catch(() => setCustDupes([]))
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

  async function saveGuestEdit() {
    setBusy(true)
    try {
      const g = guestEdit
      if (g.fullName.trim() !== g.origName) {
        await updateGuestIdentity(g.guestId, { fullName: g.fullName.trim(), phone: g.phone })
      } else if ((g.phone || '') !== (g.origPhone || '')) {
        await updateGuestIdentity(g.guestId, { fullName: g.fullName.trim(), phone: g.phone })
      }
      if (g.checkIn !== g.origCheckIn || g.scheduledOut !== g.origScheduledOut) {
        await correctStayDates({ stayId: g.stayId, checkIn: g.checkIn, scheduledOut: g.scheduledOut })
      }
      toast('Correction saved', 'success')
      setGuestEdit(null)
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
          ...(!ownOnly ? [['history', 'Change history']] : [])].map(([k, label]) => (
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
        placeholder="Search by item, customer, department, or date (YYYY-MM-DD)"
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
                    room: s2.rooms?.room_number,
                  })}
                  className="shrink-0 h-10 px-4 rounded-xl border border-amber text-amber font-semibold text-sm">
                  Edit
                </button>
              </li>
            ))}
          </ul>
          {canMerge && !!dupes?.length && (
            <div className="mt-4 rounded-2xl border border-clay bg-surface p-4">
              <p className="font-semibold">Possible duplicate guests</p>
              <p className="text-dim text-xs mt-1 mb-3">
                Same person entered twice. Check each one — a shared phone can
                also just mean two people in one family. Merging moves every
                stay, room charge and department balance onto the record you keep.
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
                </div>
              ))}
            </div>
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
            <div className="mt-4 rounded-2xl border border-clay bg-surface p-4">
              <p className="font-semibold">Possible duplicate customers</p>
              <p className="text-dim text-xs mt-1 mb-3">
                Credit accounts, not room guests. Balances and departments are
                shown because the name alone is rarely enough to tell which
                record to keep. Merging moves every sale and repayment onto the
                one you keep.
              </p>
              {custDupes.map((d, i) => (
                <div key={i} className="py-2 border-t border-line/60 first:border-0">
                  <div className="text-xs text-dim mb-1">{d.reason}</div>
                  <div className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="truncate">{d.name_a}
                        <span className="text-dim"> · {d.depts_a}</span>
                      </span>
                      <span className="tnum shrink-0 text-clay">{naira(d.bal_a)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="truncate">{d.name_b}
                        <span className="text-dim"> · {d.depts_b}</span>
                      </span>
                      <span className="tnum shrink-0 text-clay">{naira(d.bal_b)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setMergingCust({
                        survivorId: d.cust_a, survivorName: d.name_a,
                        dupId: d.cust_b, dupName: d.name_b,
                        total: Number(d.bal_a) + Number(d.bal_b) })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_a}"
                    </button>
                    <button
                      onClick={() => setMergingCust({
                        survivorId: d.cust_b, survivorName: d.name_b,
                        dupId: d.cust_a, dupName: d.name_a,
                        total: Number(d.bal_a) + Number(d.bal_b) })}
                      className="flex-1 h-9 rounded-lg border border-line text-dim text-xs px-2 truncate">
                      Keep "{d.name_b}"
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {canMerge && custDupes?.length === 0 && (
            <p className="text-dim text-sm mt-2">No likely duplicate customers found.</p>
          )}
          {canMerge && !!custDupes?.length && (
            <div className="mt-4 rounded-2xl border border-clay bg-surface p-4">
              <p className="font-semibold">Possible duplicate customers</p>
              <p className="text-dim text-xs mt-1 mb-3">
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
                </div>
              ))}
            </div>
          )}
          {canMerge && custDupes?.length === 0 && (
            <p className="text-dim text-sm mt-4">No likely duplicate customers found.</p>
          )}
        </>
      ) : view === 'history' ? (
        <ul className="divide-y divide-line/60">
          {filteredAudit.map(a => (
            <li key={a.id} className="py-3">
              <div className="flex items-baseline gap-3">
                <span className={`text-sm font-bold ${a.action === 'deleted' ? 'text-clay' : 'text-amber'}`}>
                  {a.action === 'deleted' ? 'Deleted' : 'Edited'}
                </span>
                <span className="flex-1" />
                <span className="tnum text-dim text-sm">
                  {new Date(a.happened_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos',
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="mt-1">{a.summary}</p>
              <p className="text-dim text-sm mt-0.5">by {a.done_by_name || 'unknown'}</p>
            </li>
          ))}
          {audit && !filteredAudit.length && (
            <li className="py-8 text-center text-dim">
              {audit.length ? 'Nothing matches that search.' : 'Nothing has been changed or deleted yet.'}
            </li>
          )}
          {!audit && <li className="py-8 text-center text-dim">Loading…</li>}
        </ul>
      ) : (
      <>
      <p className="text-dim text-sm pb-2">
        {ownOnly
          ? 'Your own entries from today and yesterday. You can correct them here; ask a manager if something needs removing.'
          : 'Last 14 days. Deleting a sale also reverses its stock deduction.'}
      </p>
      <ul className="divide-y divide-line/60">
        {filteredRows.map(r => {
          const d = describe(r)
          return (
            <li key={`${r.kind}:${r.id}`} className="py-3">
              <div className="flex items-baseline gap-3">
                <span className="flex-1 min-w-0 truncate font-semibold">{d.title}</span>
                <span className="tnum text-dim text-sm">{r.business_date?.slice(5)}</span>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="flex-1 text-dim text-sm truncate">{d.detail}</span>
                <span className="tnum">{r.qty}</span>
                {d.money && <span className="tnum text-dim">{d.money}</span>}
              </div>
              <div className="flex gap-2 mt-2">
                {(isEditor || (r.recorded_by === staff.id && r.business_date >= lagosDaysAgo(1))) && (
                  <button onClick={() => openEdit(r)}
                    className="h-10 px-4 rounded-lg border border-line text-sm font-semibold">Edit</button>
                )}
                {!isEditor && r.recorded_by === staff.id && r.business_date < lagosDaysAgo(1) && (
                  <span className="text-dim text-sm self-center">
                    Too old to edit yourself — ask a manager
                  </span>
                )}
                {(isEditor || (isStorekeeper && r.kind !== 'sale'
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
        {!filteredRows.length && (
          <li className="py-8 text-center text-dim">
            {rows.length ? 'Nothing matches that search.' : 'No entries in the last 14 days.'}
          </li>
        )}
      </ul>
      </>
      )}

      {edit && (
        <Sheet onClose={() => setEdit(null)}>
          <h2 className="text-2xl font-bold">{describe(edit.row).title}</h2>
          <p className="text-dim mt-1">{describe(edit.row).detail}</p>
          <label className="block mt-6 text-dim">Quantity</label>
          <input type="number" inputMode="decimal" value={edit.qty}
            onChange={e => setEdit({ ...edit, qty: e.target.value })}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />
          <label className="block mt-4 text-dim">
            {edit.row.kind === 'sale' ? 'Unit price' : 'Unit cost (optional)'}
          </label>
          <input type="number" inputMode="decimal" value={edit.price}
            onChange={e => setEdit({ ...edit, price: e.target.value })}
            className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />
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

      {mergingCust && (
        <Sheet onClose={() => setMergingCust(null)}>
          <h3 className="text-xl font-bold">Merge customer records</h3>
          <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="text-dim text-sm">Keeping</div>
            <div className="font-semibold">{mergingCust.survivorName}</div>
            <div className="text-dim text-sm mt-3">Merging in and closing</div>
            <div className="font-semibold text-clay">{mergingCust.dupName}</div>
            <div className="text-dim text-sm mt-3">Combined balance after merge</div>
            <div className="tnum font-bold text-clay">{naira(mergingCust.total)}</div>
          </div>
          <p className="text-dim text-sm mt-4">
            Every sale and repayment under "{mergingCust.dupName}" moves onto
            "{mergingCust.survivorName}", so their debts combine into the single
            figure above. The closed record is renamed and kept, not deleted, so
            receipts already issued still resolve.
          </p>
          <p className="text-clay text-sm mt-3">
            This moves real money between accounts. Be sure they are the same
            person — undoing it means re-pointing each sale by hand.
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
        <Sheet onClose={() => setGuestEdit(null)}>
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
            onChange={e => setGuestEdit(g => ({ ...g, checkIn: e.target.value }))}
            className="h-12 px-3 rounded-xl bg-raise border border-line tnum" />

          <div className="text-dim text-sm mt-3 mb-1">Scheduled check-out</div>
          <input type="date" value={guestEdit.scheduledOut} min={guestEdit.checkIn}
            onChange={e => setGuestEdit(g => ({ ...g, scheduledOut: e.target.value }))}
            className="h-12 px-3 rounded-xl bg-raise border border-line tnum" />

          <p className="text-dim text-xs mt-3">
            Moving the dates is checked against the room's other bookings — if it
            would clash, the save is refused and nothing changes.
          </p>

          <button onClick={saveGuestEdit}
            disabled={busy || !guestEdit.fullName.trim() || !guestEdit.checkIn || !guestEdit.scheduledOut}
            className="mt-5 h-12 w-full rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </Sheet>
      )}

      {confirm && (
        <Sheet onClose={() => setConfirm(null)}>
          <h2 className="text-2xl font-bold">Delete this entry?</h2>
          <p className="text-dim mt-2">
            {describe(confirm).title} · {describe(confirm).detail} · {confirm.qty}
          </p>
          <p className="text-dim mt-3">This cannot be undone. Stock returns to what it was.</p>
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
