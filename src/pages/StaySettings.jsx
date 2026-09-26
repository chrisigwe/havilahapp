import { useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { loadRoomsForSettings, loadBranchStaySettings, updateRoomRates,
         updateBranchOverstayDefault, loadStaffOfMonth, postStaffOfMonth } from '../lib/data'
import { useToast } from '../components/Toast'
import MergeGuestsSheet from '../components/MergeGuestsSheet'

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

  const canManageRooms = ['manager', 'gm', 'admin'].includes(staff.role)
  const canSetOverstayDefault = ['gm', 'admin'].includes(staff.role)
  const [mergingGuests, setMergingGuests] = useState(false)

  // Staff of the Month — GM/admin only, matches canSetOverstayDefault
  // exactly (is_supervisor()'s own role set), kept as a separate name
  // here since the two features have nothing to do with each other.
  const canPostStaffOfMonth = canSetOverstayDefault
  const [somEntry, setSomEntry] = useState(null)
  const [somName, setSomName] = useState('')
  const [somPhotoFile, setSomPhotoFile] = useState(null)
  const [somPhotoPreview, setSomPhotoPreview] = useState(null)
  const [somRemovePhoto, setSomRemovePhoto] = useState(false)
  const [somBusy, setSomBusy] = useState(false)

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
    loadStaffOfMonth().then(e => { setSomEntry(e); setSomName(e?.staff_name || '') }).catch(() => setSomEntry(null))
  }, [canPostStaffOfMonth])

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
      await postStaffOfMonth({
        staffId: staff.id, staffName: somName.trim(),
        photoFile: somPhotoFile, removePhoto: somRemovePhoto,
        currentPhotoUrl: somEntry?.photo_url || null,
      })
      toast('Staff of the Month posted', 'success')
      setSomPhotoFile(null); setSomPhotoPreview(null); setSomRemovePhoto(false)
      loadStaffOfMonth().then(e => { setSomEntry(e); setSomName(e?.staff_name || '') })
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
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
            Shown as a banner across the app to everyone, at both branches, for
            7 days after posting. Recognizes the ₦10,000 grand-prize winner for
            great customer service, teamwork, and performance.
          </p>
          {somEntry?.isActive && (
            <p className="text-leaf text-sm mb-3">
              Currently live · {7 - somEntry.daysSince} day{7 - somEntry.daysSince === 1 ? '' : 's'} left
            </p>
          )}
          {somEntry && !somEntry.isActive && (
            <p className="text-dim text-sm mb-3">
              No banner showing right now — the last post has expired.
            </p>
          )}

          <div className="text-dim text-sm mb-1">Staff name</div>
          <input value={somName} onChange={e => setSomName(e.target.value)}
            placeholder="Full name" autoComplete="off"
            className="h-12 w-full px-3 rounded-xl bg-raise border border-line" />

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

          <button onClick={saveStaffOfMonth} disabled={somBusy || !somName.trim()}
            className="mt-4 h-12 px-5 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">
            {somBusy ? 'Posting…' : 'Post'}
          </button>
        </section>
      )}

      {canSetOverstayDefault && (
        <section className="mt-5 rounded-2xl border border-line bg-surface p-4">
          <h3 className="font-semibold">Guest records</h3>
          <p className="text-dim text-sm mt-1 mb-3">
            If the same guest ended up with more than one record — different
            spellings of their name over time — merge them into one so their
            full history and current balance live in a single place.
          </p>
          <button onClick={() => setMergingGuests(true)}
            className="h-12 px-5 rounded-xl border border-amber text-amber font-semibold">
            Merge duplicate guests
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

      {mergingGuests && <MergeGuestsSheet boot={boot} onClose={() => setMergingGuests(false)} />}
    </div>
  )
}
