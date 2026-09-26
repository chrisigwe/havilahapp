import { useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, nightsBetween, addDays, cyclesFor, friendlyStayError } from '../lib/format'
import { loadFreeRooms, loadBranchStaySettings, findOrCreateGuest, createStay, searchSimilarGuests } from '../lib/data'
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
  const [billToGuestId, setBillToGuestId] = useState(null)
  const [billToSuggestions, setBillToSuggestions] = useState([])
  const [billToOpen, setBillToOpen] = useState(false)
  const [similarGuests, setSimilarGuests] = useState([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)

  // Debounced — a similar-name search on every keystroke would be
  // wasteful and flickery. 400ms is enough to wait for a pause in
  // typing without feeling laggy.
  useEffect(() => {
    if (!suggestionsOpen) return
    const t = setTimeout(() => {
      searchSimilarGuests(staff.branch_id, name).then(setSimilarGuests)
    }, 400)
    return () => clearTimeout(t)
  }, [name, staff.branch_id, suggestionsOpen])

  useEffect(() => {
    if (!billToOpen) return
    const t = setTimeout(() => {
      searchSimilarGuests(staff.branch_id, billTo).then(setBillToSuggestions)
    }, 400)
    return () => clearTimeout(t)
  }, [billTo, staff.branch_id, billToOpen])

  useEffect(() => {
    loadFreeRooms(staff.branch_id, checkIn, scheduledOut).then(list => {
      setRooms(list)
      // The previously-picked room may no longer be free for the
      // newly-selected dates — don't let a stale selection through.
      setRoomId(cur => list.some(r => r.id === cur) ? cur : null)
    }).catch(() => setRooms([]))
  }, [staff.branch_id, checkIn, scheduledOut])

  useEffect(() => {
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
        billingCycle: cycle, checkIn, scheduledOut, billTo: billTo.trim(), billToGuestId,
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
        <input value={name} onChange={e => { setName(e.target.value); setSuggestionsOpen(true) }}
          onFocus={() => setSuggestionsOpen(true)} autoFocus
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line" />
        {suggestionsOpen && !!similarGuests.length && (
          <div className="mt-2 rounded-xl border border-amber bg-surface divide-y divide-line overflow-hidden">
            <div className="px-4 py-2 text-dim text-sm">Similar guest already exists — same person?</div>
            {similarGuests.map(g => (
              <button key={g.id} type="button"
                onClick={() => {
                  setName(g.full_name); setPhone(g.phone || '')
                  setSuggestionsOpen(false); setSimilarGuests([])
                }}
                className="block w-full text-left px-4 py-3 hover:bg-raise">
                <div className="font-semibold">{g.full_name}</div>
                {g.phone && <div className="text-dim text-sm">{g.phone}</div>}
              </button>
            ))}
            <button type="button" onClick={() => { setSuggestionsOpen(false); setSimilarGuests([]) }}
              className="block w-full text-center px-4 py-2 text-dim text-sm">
              No, this is a different person
            </button>
          </div>
        )}
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
            className="h-14 px-3 rounded-xl bg-surface border border-line tnum" />
        </div>
        <div className="flex-1">
          <div className="text-dim mb-1">Scheduled check-out</div>
          <input type="date" value={scheduledOut} min={checkIn}
            onChange={e => setScheduledOut(e.target.value)}
            className="h-14 px-3 rounded-xl bg-surface border border-line tnum" />
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
        <input value={billTo}
          onChange={e => { setBillTo(e.target.value); setBillToGuestId(null); setBillToOpen(true) }}
          onFocus={() => setBillToOpen(true)}
          placeholder="Leave blank if the guest pays their own bill"
          className="h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
        {billToOpen && !!billToSuggestions.length && (
          <div className="mt-2 rounded-xl border border-amber bg-surface divide-y divide-line overflow-hidden">
            <div className="px-4 py-2 text-dim text-sm">Is this an existing guest?</div>
            {billToSuggestions.map(g => (
              <button key={g.id} type="button"
                onClick={() => {
                  setBillTo(g.full_name); setBillToGuestId(g.id)
                  setBillToOpen(false); setBillToSuggestions([])
                }}
                className="block w-full text-left px-4 py-3 hover:bg-raise">
                <div className="font-semibold">{g.full_name}</div>
                {g.phone && <div className="text-dim text-sm">{g.phone}</div>}
              </button>
            ))}
            <button type="button" onClick={() => { setBillToOpen(false); setBillToSuggestions([]) }}
              className="block w-full text-center px-4 py-2 text-dim text-sm">
              No — not a guest (company, relative, etc.)
            </button>
          </div>
        )}
        <p className="text-dim text-sm mt-1">
          If someone else is responsible for this bill — a long-term guest vouching
          for a visitor, a company, a relative — note it here so it's visible from
          check-in, not just discoverable later in a payment note.
          {billToGuestId && ' Linked — this amount will also show on their own folio.'}
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
