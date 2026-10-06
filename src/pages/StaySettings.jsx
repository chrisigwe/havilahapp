import { useEffect, useState } from 'react'
import { loadRoomsForSettings, loadBranchStaySettings, updateRoomRates,
         updateBranchOverstayDefault, loadStaffOfMonth, postStaffOfMonth,
         deleteStaffOfMonth } from '../lib/data'
import { loadAwardPayroll, loadDraftPeriods, loadEmployees, setAwardPayroll } from '../lib/payroll'
import { lagosToday } from '../lib/format'
import { useToast } from '../components/Toast'
import { SUPERVISOR, is } from '../lib/roles'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// "SURNAME, Given Names" or a "Known as (staff)" name -> what the banner
// should say. Only a starting suggestion: the name stays editable.
function displayNameOf(emp) {
  if (emp.aka) return emp.aka.replace(/\(staff\)/i, '').trim()
  const given = String(emp.full_name || '').split(',')[1] || emp.full_name || ''
  const first = given.trim().split(/\s+/)[0] || ''
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

const RATE_FIELDS = { standard: 'rate_standard', alternate: 'rate_alternate', short: 'rate_short' }

// Named StaySettings (not Settings) — this app's own More menu is a
// settings surface in the broader sense already; this page is
// specifically room rates and the branch overstay default, matching
// exactly what the reference app's Settings screen covers and
// nothing more. It never built room creation or category management
// even though the database permits both (rooms_write, rooms_delete,
// room_categories_write all exist) — matched that scope deliberately
// rather than silently building beyond what was proven to be needed.
export default function StaySettings({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [rooms, setRooms] = useState(null)
  const [branchSettings, setBranchSettings] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [fee, setFee] = useState('')
  const [busy, setBusy] = useState(false)

  // GM/admin only (migration 256). Room rates joined over-stay and Staff
  // of the Month as GM authority, matching item prices in Catalog — which
  // left nothing on this page for managers.
  const canManageRooms = is(staff.role, SUPERVISOR)
  const canSetOverstayDefault = is(staff.role, SUPERVISOR)

  // Staff of the Month — GM/admin only, matches canSetOverstayDefault
  // exactly (is_supervisor()'s own role set), kept as a separate name
  // here since the two features have nothing to do with each other.
  const canPostStaffOfMonth = canSetOverstayDefault
  const [somEntry, setSomEntry] = useState(null)
  const [somName, setSomName] = useState('')
  const [somPrizeAmount, setSomPrizeAmount] = useState('10000')
  const [somPhotoFile, setSomPhotoFile] = useState(null)
  const [somPhotoPreview, setSomPhotoPreview] = useState(null)
  const [somRemovePhoto, setSomRemovePhoto] = useState(false)
  const [somBusy, setSomBusy] = useState(false)
  const [confirmingSomDelete, setConfirmingSomDelete] = useState(false)
  // Linking the prize to salary. Optional: with no employee chosen the post
  // is the banner only, exactly as before.
  const [employees, setEmployees] = useState([])
  const [draftPeriods, setDraftPeriods] = useState([])
  const [somEmployeeId, setSomEmployeeId] = useState('')
  const [somPeriodId, setSomPeriodId] = useState('')
  const [somLinked, setSomLinked] = useState(false)

  useEffect(() => {
    if (!canManageRooms) return
    loadRoomsForSettings(staff.branch_id).then(setRooms).catch(() => setRooms([]))
    loadBranchStaySettings(staff.branch_id).then(s => {
      setBranchSettings(s)
      setFee(s.overstayDefault != null ? String(s.overstayDefault) : '')
    }).catch(() => setBranchSettings(null))
  }, [staff.branch_id, canManageRooms])

  useEffect(() => {
    if (!canPostStaffOfMonth) return
    loadStaffOfMonth(staff.branch_id).then(e => {
      setSomEntry(e); setSomName(e?.staff_name || ''); setSomPrizeAmount(e ? String(e.prize_amount) : '10000')
      // Pre-fill the salary link ONLY for a same-day correction, which updates
      // that post in place. Any other post is a new row, so it starts blank
      // rather than offering last month's winner.
      if (e && e.posted_at === lagosToday()) {
        loadAwardPayroll(e.id).then(l => {
          setSomLinked(!!l); setSomEmployeeId(l?.employeeId || ''); setSomPeriodId(l?.periodId || '')
        }).catch(() => {})
      }
    }).catch(() => setSomEntry(null))
    loadEmployees(staff.branch_id).then(setEmployees).catch(() => setEmployees([]))
    loadDraftPeriods(staff.branch_id).then(setDraftPeriods).catch(() => setDraftPeriods([]))
  }, [canPostStaffOfMonth, staff.branch_id])

  if (!canManageRooms) {
    return (
      <div className="px-5">
        <h2 className="text-2xl font-bold mt-2">Settings</h2>
        <p className="text-dim mt-2">Room rates and charges are managed by a manager, GM, or admin.</p>
      </div>
    )
  }
  if (rooms === null) return <p className="px-5 text-dim">Loading…</p>

  const labels = branchSettings?.rateLabels || { standard: 'Standard', alternate: 'Discounted', short: 'Short-time' }

  function edit(roomId, key, value) {
    setDrafts(d => ({ ...d, [roomId]: { ...d[roomId], [key]: value } }))
  }

  async function saveRoom(room) {
    const draft = drafts[room.id]
    if (!draft) return
    setBusy(true)
    const patch = {}
    for (const [key, field] of Object.entries(RATE_FIELDS)) {
      if (draft[key] !== undefined && draft[key] !== '') patch[field] = Number(draft[key])
    }
    try {
      await updateRoomRates(room.id, patch)
      setDrafts(d => { const n = { ...d }; delete n[room.id]; return n })
      toast(`Room ${room.room_number} updated`, 'success')
      loadRoomsForSettings(staff.branch_id).then(setRooms)
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  async function saveFee() {
    setBusy(true)
    try {
      await updateBranchOverstayDefault(staff.branch_id, Number(fee))
      toast('Over-stay charge updated', 'success')
      setBranchSettings(s => ({ ...s, overstayDefault: Number(fee) }))
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  function pickSomPhoto(e) {
    const file = e.target.files?.[0] || null
    setSomPhotoFile(file)
    setSomRemovePhoto(false)
    setSomPhotoPreview(file ? URL.createObjectURL(file) : null)
  }

  async function saveStaffOfMonth() {
    setSomBusy(true)
    try {
      const awardId = await postStaffOfMonth({
        branchId: staff.branch_id, staffId: staff.id, staffName: somName.trim(),
        prizeAmount: Number(somPrizeAmount) || 0,
        photoFile: somPhotoFile, removePhoto: somRemovePhoto,
        currentPhotoUrl: somEntry?.photo_url || null,
      })
      // The banner is already posted; adding the prize to salary is a
      // second step, and if it fails the GM must be told plainly that the
      // money is NOT on anyone's payroll, not left to assume it worked.
      if (somEmployeeId || somLinked) {
        try {
          const r = await setAwardPayroll(awardId, somEmployeeId || null, somPeriodId || null, Number(somPrizeAmount) || 0)
          // Believe the DATABASE, not the form: with no month chosen it
          // returns linked:false without an error, and saying "it is on
          // their salary" then would be false.
          setSomLinked(!!r?.linked)
          if (somEmployeeId && !r?.linked) {
            toast('Posted, but the prize was NOT added to salary — no open payroll month was chosen.',
                  'error', { duration: 14000 })
          } else {
            toast(somEmployeeId ? 'Posted — the prize is on their salary' : 'Posted — prize taken off salary', 'success')
          }
        } catch (err) {
          toast('Posted, but the prize was NOT added to salary: ' + err.message, 'error', { duration: 14000 })
        }
      } else toast('Staff of the Month posted', 'success')
      setSomPhotoFile(null); setSomPhotoPreview(null); setSomRemovePhoto(false)
      loadStaffOfMonth(staff.branch_id).then(e => { setSomEntry(e); setSomName(e?.staff_name || ''); setSomPrizeAmount(e ? String(e.prize_amount) : '10000') })
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setSomBusy(false)
  }

  async function removeStaffOfMonth() {
    if (!somEntry) return
    setSomBusy(true)
    try {
      // Take the prize off payroll first. If its month is already
      // finalised this refuses, and the post is left alone rather than
      // leaving paid money with no award behind it.
      if (somLinked) await setAwardPayroll(somEntry.id, null, null, 0)
      await deleteStaffOfMonth(somEntry.id)
      setSomLinked(false); setSomEmployeeId(''); setSomPeriodId('')
      toast('Post deleted', 'success')
      setConfirmingSomDelete(false)
      setSomEntry(null); setSomName(''); setSomPrizeAmount('10000'); setSomPhotoFile(null); setSomPhotoPreview(null); setSomRemovePhoto(false)
    } catch (e) { toast('Not deleted: ' + e.message, 'error') }
    setSomBusy(false)
  }

  return (
    <div className="px-5 pb-8">
      <h2 className="text-2xl font-bold mt-2">Settings</h2>

      {canSetOverstayDefault && (
        <section className="mt-5 rounded-2xl border border-line bg-surface p-4">
          <h3 className="font-semibold">Over-stay charge</h3>
          <p className="text-dim text-sm mt-1 mb-3">
            Added to a guest's bill when they stay past checkout. Front desk can
            apply this amount on any stay; only GM or admin can change the default
            or use a different one.
          </p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <div className="text-dim text-sm mb-1">Amount</div>
              <input type="number" inputMode="decimal" min="0" value={fee}
                onChange={e => setFee(e.target.value)}
                className="h-12 w-full px-3 rounded-xl bg-raise border border-line tnum" />
            </div>
            <button onClick={saveFee} disabled={busy || fee === ''}
              className="h-12 px-5 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
              Save
            </button>
          </div>
        </section>
      )}

      {canPostStaffOfMonth && (
        <section className="mt-5 rounded-2xl border border-line bg-surface p-4">
          <h3 className="font-semibold">Staff of the Month</h3>
          <p className="text-dim text-sm mt-1 mb-3">
            Shown as a banner to everyone at this branch for 7 days after
            posting. Recognizes the ₦10,000 grand-prize winner for great
            customer service, teamwork, and performance. Nnewi and Awka each
            have their own winner — this only posts for the branch you're
            currently viewing.
          </p>
          {somEntry?.isActive && (
            <p className="text-leaf text-sm mb-1">
              Currently live · {7 - somEntry.daysSince} day{7 - somEntry.daysSince === 1 ? '' : 's'} left
            </p>
          )}
          {somEntry && !somEntry.isActive && (
            <p className="text-dim text-sm mb-1">
              No banner showing right now — the last post has expired.
            </p>
          )}
          {somEntry && !confirmingSomDelete && (
            <button onClick={() => setConfirmingSomDelete(true)} className="text-clay text-sm underline mb-3">
              Delete this post
            </button>
          )}
          {somEntry && confirmingSomDelete && (
            <div className="mb-3 px-3 py-2 rounded-xl bg-clay/10 border border-clay">
              <p className="text-clay text-sm mb-2">
                Delete "{somEntry.staff_name}"'s post for good? This can't be undone.
              </p>
              <div className="flex gap-3">
                <button onClick={removeStaffOfMonth} disabled={somBusy}
                  className="h-10 px-4 rounded-lg bg-clay text-bg font-semibold text-sm disabled:opacity-40">
                  {somBusy ? 'Deleting…' : 'Yes, delete it'}
                </button>
                <button onClick={() => setConfirmingSomDelete(false)} className="text-dim text-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="text-dim text-sm mb-1">Staff name</div>
          <input value={somName} onChange={e => setSomName(e.target.value)}
            placeholder="Full name" autoComplete="off"
            className="h-12 w-full px-3 rounded-xl bg-raise border border-line" />

          <div className="text-dim text-sm mt-3 mb-1">Prize amount (₦)</div>
          <input value={somPrizeAmount} onChange={e => setSomPrizeAmount(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric" placeholder="10000"
            className="h-12 w-full px-3 rounded-xl bg-raise border border-line tnum" />

          {/* Pay the prize through salary. Optional. */}
          <div className="mt-4 rounded-xl border border-line p-3">
            <div className="text-dim text-sm mb-1">Add the prize to their salary</div>
            <select value={somEmployeeId}
              onChange={e => {
                const id = e.target.value
                setSomEmployeeId(id)
                const emp = employees.find(x => x.id === id)
                if (emp && !somName.trim()) setSomName(displayNameOf(emp))
                if (id && !somPeriodId && draftPeriods[0]) setSomPeriodId(draftPeriods[0].id)
              }}
              className="h-12 w-full px-3 rounded-xl bg-raise border border-line">
              <option value="">No — banner only</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.full_name}</option>)}
            </select>
            {somEmployeeId && (draftPeriods.length ? (
              <>
                <div className="text-dim text-sm mt-3 mb-1">With which month's salary</div>
                <select value={somPeriodId} onChange={e => setSomPeriodId(e.target.value)}
                  className="h-12 w-full px-3 rounded-xl bg-raise border border-line">
                  {draftPeriods.map(pd => (
                    <option key={pd.id} value={pd.id}>{MONTHS[pd.month - 1]} {pd.year}</option>
                  ))}
                </select>
                <p className="text-dim text-xs mt-2">
                  Shown on their payroll line as "Staff of the Month prize". Only months not yet
                  finalised are listed. Correcting this post today replaces the prize; it is
                  never added twice.
                </p>
              </>
            ) : (
              <p className="text-clay text-sm mt-2">
                No payroll month is open. Open one under Payroll first, otherwise the prize
                cannot be added to salary.
              </p>
            ))}
          </div>

          <div className="text-dim text-sm mt-3 mb-1">Photo (optional)</div>
          <input type="file" accept="image/*" onChange={pickSomPhoto} className="w-full text-sm" />
          {(somPhotoPreview || (somEntry?.photo_url && !somRemovePhoto)) && (
            <div className="flex items-center gap-3 mt-2">
              <img src={somPhotoPreview || somEntry.photo_url} alt=""
                className="w-16 h-16 rounded-full object-cover border border-line" />
              <button onClick={() => { setSomPhotoFile(null); setSomPhotoPreview(null); setSomRemovePhoto(true) }}
                className="text-clay text-sm underline">
                Remove photo
              </button>
            </div>
          )}

          <button onClick={saveStaffOfMonth} disabled={somBusy || !somName.trim() || !somPrizeAmount}
            className="mt-4 h-12 px-5 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
            {somBusy ? 'Posting…' : 'Post'}
          </button>
        </section>
      )}

      <section className="mt-5">
        <h3 className="font-semibold">Room rates</h3>
        <p className="text-dim text-sm mt-1 mb-3">
          Changing a rate affects future check-ins only — guests already in
          house keep the rate agreed when they arrived.
        </p>

        <div className="rounded-2xl border border-line bg-surface divide-y divide-line/60">
          {rooms.map(room => {
            const draft = drafts[room.id] ?? {}
            const dirty = Object.keys(draft).length > 0
            return (
              <div key={room.id} className="p-4">
                <div className="flex items-baseline gap-3 mb-3">
                  <span className="text-lg font-bold tnum">{room.room_number}</span>
                  <span className="text-dim text-sm">{room.room_categories?.name}</span>
                  {!room.is_active && <span className="text-clay text-sm">inactive</span>}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {Object.entries(RATE_FIELDS).map(([key, field]) => (
                    <div key={key}>
                      <div className="text-dim text-sm mb-1">{labels[key]}</div>
                      <input type="number" inputMode="decimal" min="0"
                        value={draft[key] ?? room[field] ?? 0}
                        onChange={e => edit(room.id, key, e.target.value)}
                        className="h-11 w-full px-2 rounded-xl bg-raise border border-line tnum text-sm" />
                    </div>
                  ))}
                </div>
                {dirty && (
                  <div className="flex gap-3 mt-3">
                    <button onClick={() => saveRoom(room)} disabled={busy}
                      className="flex-1 h-11 rounded-xl bg-amber text-bg font-semibold disabled:opacity-40">
                      Save room {room.room_number}
                    </button>
                    <button
                      onClick={() => setDrafts(d => { const n = { ...d }; delete n[room.id]; return n })}
                      className="flex-1 h-11 text-dim">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {!rooms.length && <p className="p-6 text-dim">No rooms set up for this branch yet.</p>}
        </div>
      </section>

    </div>
  )
}
