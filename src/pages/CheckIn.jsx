import { useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, nightsBetween, addDays, cyclesFor, friendlyStayError } from '../lib/format'
import { loadFreeRooms, loadBranchStaySettings, findOrCreateGuest, createStay } from '../lib/data'
import { useToast } from '../components/Toast'

const RATE_FIELDS = { standard: 'rate_standard', alternate: 'rate_alternate', short: 'rate_short' }

export default function CheckIn({ boot, onDone }) {
  const { staff } = boot
  const toast = useToast()
  const [rooms, setRooms] = useState(null)
  const [allowedCycles, setAllowedCycles] = useState(null)
  const [rateLabels, setRateLabels] = useState({ standard: 'Standard', alternate: 'Discounted', short: 'Short-time' })
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [roomId, setRoomId] = useState('')
  const [rateType, setRateType] = useState('standard')
  const [rateOverride, setRateOverride] = useState('')
  const [checkIn, setCheckIn] = useState(lagosToday())
  const [scheduledOut, setScheduledOut] = useState(addDays(lagosToday(), 1))
  const [cycle, setCycle] = useState('one_off')
  const [reserve, setReserve] = useState(false)
  const [billTo, setBillTo] = useState('')

  useEffect(() => {
    loadFreeRooms(staff.branch_id).then(setRooms).catch(() => setRooms([]))
    loadBranchStaySettings(staff.branch_id).then(s => {
      setAllowedCycles(s.allowedCycles)
      setRateLabels(s.rateLabels)
    }).catch(() => setAllowedCycles(null))
  }, [staff.branch_id])

  const cycles = useMemo(() => cyclesFor(allowedCycles), [allowedCycles])
  useEffect(() => {
    if (cycles.length && !cycles.some(c => c.value === cycle)) setCycle(cycles[0].value)
  }, [cycles])

  const room = (rooms || []).find(r => r.id === roomId) || null
  const listRate = room ? Number(room[RATE_FIELDS[rateType]] ?? 0) : 0
  const rate = rateOverride === '' ? listRate : Number(rateOverride)
  const nights = checkIn && scheduledOut ? nightsBetween(checkIn, scheduledOut) : 0
  const valid = name.trim() && roomId && checkIn && scheduledOut && rate >= 0

  async function submit() {
    setBusy(true)
    try {
      const guestId = await findOrCreateGuest(staff.branch_id, name, phone)
      await createStay({
        staff, guestId, roomId, rateType, dailyRate: rate, reserve,
        billingCycle: cycle, checkIn, scheduledOut, billTo: billTo.trim(),
      })
      toast(reserve ? 'Reservation saved' : `Checked in — Room ${room?.room_number}`, 'success')
      onDone?.()
    } catch (e) { toast(friendlyStayError(e), 'error') }
    setBusy(false)
  }

  if (rooms === null) return <p className="px-5 text-dim">Loading…</p>

  return (
    <div className="px-5">
      <h2 className="text-2xl font-bold mt-2">New booking</h2>

      <div className="mt-5">
        <div className="text-dim mb-1">Guest name</div>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line" />
      </div>
      <div className="mt-4">
        <div className="text-dim mb-1">Phone number</div>
        <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel"
          placeholder="Matches a returning guest to their history"
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
      </div>

      <div className="mt-4">
        <div className="text-dim mb-1">
          Room {rooms.length ? `(${rooms.length} free)` : '(none free)'}
        </div>
        <select value={roomId} onChange={e => { setRoomId(e.target.value); setRateOverride('') }}
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line">
          <option value="">Select a room</option>
          {rooms.map(r => (
            <option key={r.id} value={r.id}>
              {r.room_number}{r.room_categories?.name ? ` — ${r.room_categories.name}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 flex gap-3">
        <div className="flex-1">
          <div className="text-dim mb-1">Rate type</div>
          <select value={rateType} onChange={e => { setRateType(e.target.value); setRateOverride('') }}
            className="h-14 w-full px-3 rounded-xl bg-surface border border-line">
            {Object.entries(rateLabels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <div className="text-dim mb-1">
            Daily rate {room && rateOverride !== '' && rate !== listRate ? `(list: ${naira(listRate)})` : ''}
          </div>
          <input type="number" inputMode="decimal"
            value={rateOverride === '' ? (listRate || '') : rateOverride}
            onChange={e => setRateOverride(e.target.value)}
            className="h-14 w-full px-3 rounded-xl bg-surface border border-line tnum" />
        </div>
      </div>

      <div className="mt-4 flex gap-3">
        <div className="flex-1">
          <div className="text-dim mb-1">Check-in date</div>
          <input type="date" value={checkIn}
            onChange={e => setCheckIn(e.target.value)}
            className="h-14 w-full px-3 rounded-xl bg-surface border border-line tnum" />
        </div>
        <div className="flex-1">
          <div className="text-dim mb-1">Scheduled check-out</div>
          <input type="date" value={scheduledOut} min={checkIn}
            onChange={e => setScheduledOut(e.target.value)}
            className="h-14 w-full px-3 rounded-xl bg-surface border border-line tnum" />
        </div>
      </div>

      <div className="mt-4">
        <div className="text-dim mb-1">Billing cycle</div>
        <div className="flex gap-2">
          {cycles.map(c => (
            <button key={c.value} onClick={() => setCycle(c.value)}
              className={`flex-1 h-12 rounded-xl border font-semibold ${cycle === c.value
                ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-4 flex items-center gap-2 text-dim">
        <input type="checkbox" checked={reserve} onChange={e => setReserve(e.target.checked)} />
        Reservation only — guest has not arrived yet
      </label>

      <div className="mt-4">
        <div className="text-dim mb-1">Billed to (optional)</div>
        <input value={billTo} onChange={e => setBillTo(e.target.value)}
          placeholder="Leave blank if the guest pays their own bill"
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        <p className="text-dim text-sm mt-1">
          If someone else is responsible for this bill — a long-term guest vouching
          for a visitor, a company, a relative — note it here so it's visible from
          check-in, not just discoverable later in a payment note.
        </p>
      </div>

      {room && nights > 0 && (
        <div className="mt-4 flex items-baseline justify-between rounded-xl bg-surface border border-line px-4 py-3">
          <span className="text-dim tnum">{nights} night{nights > 1 ? 's' : ''} × {naira(rate)}</span>
          <span className="text-xl font-bold tnum">{naira(nights * rate)}</span>
        </div>
      )}

      <button onClick={submit} disabled={busy || !valid}
        className="mt-6 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
        {busy ? 'Saving…' : reserve ? 'Save reservation' : 'Check in'}
      </button>
    </div>
  )
}
