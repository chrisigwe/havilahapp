import { useEffect, useState } from 'react'
import { naira, lagosToday } from '../lib/format'
import { searchLiveStays, chargeItemToRoom } from '../lib/data'
import RoomItemPicker from './RoomItemPicker'

// Charges items to a hotel room/guest stay — the front desk's own
// side of this (their FolioDrawer) adds one item at a time, each its
// own order, so this matches that exactly: a guest's bill looks the
// same whether it was added here or there.
export default function RoomChargeSheet({ boot, stockMap, onClose, toast }) {
  const { staff, items, allLocations } = boot
  // Only departments a room charge should ever draw from: the real
  // sales points (bar/minimart) plus Kitchen specifically for food —
  // Kitchen isn't flagged as a sales point in the schema (it's a
  // consuming department, not a walk-up counter), but it's exactly
  // what a restaurant order needs to pull from. Housekeeping, Others,
  // and the store itself are excluded — nothing there should ever be
  // "ordered" to a guest's room.
  const orderableLocations = allLocations.filter(l =>
    !l.is_store && (l.is_sales_point || /kitchen/i.test(l.name)))
  const [q, setQ] = useState('')
  const [stays, setStays] = useState(null)
  const [stay, setStay] = useState(null)
  const [charged, setCharged] = useState([])   // this session's charges
  const [picking, setPicking] = useState(false)
  const [pending, setPending] = useState(null) // { item, loc, qty, unitPrice }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (stay) return
    const t = setTimeout(() => {
      searchLiveStays(staff.branch_id, q).then(setStays).catch(() => setStays([]))
    }, 200)
    return () => clearTimeout(t)
  }, [q, staff.branch_id, stay])

  async function confirmCharge() {
    if (!pending) return
    setBusy(true)
    try {
      await chargeItemToRoom({
        staff, stayId: stay.id, item: pending.item,
        locationId: pending.loc.id, locationName: pending.loc.name,
        qty: pending.qty, unitPrice: pending.unitPrice, businessDate: lagosToday(),
      })
      setCharged(c => [{ ...pending, at: Date.now() }, ...c])
      setPending(null)
      toast(`${pending.qty} × ${pending.item.name} charged to Room ${stay.rooms?.room_number}`, 'success')
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col">
      <div className="p-5 flex-1 overflow-y-auto">
        <button onClick={onClose} className="text-dim">Close</button>

        {!stay ? (
          <>
            <h2 className="mt-3 text-2xl font-bold">Charge to a room</h2>
            <p className="text-dim mt-1">Find the guest by room number or name.</p>
            <input value={q} onChange={e => setQ(e.target.value)} autoFocus
              placeholder="Room number or guest name"
              className="mt-4 w-full h-14 px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
            <ul className="mt-4 divide-y divide-line/60">
              {(stays || []).map(s => (
                <li key={s.id}>
                  <button onClick={() => setStay(s)} className="w-full text-left py-3">
                    <div className="flex items-center gap-3">
                      <span className="font-bold w-14">{s.rooms?.room_number}</span>
                      <span className="flex-1 min-w-0 truncate">{s.guests?.full_name}</span>
                      <span className="text-dim text-sm capitalize">{s.status}</span>
                    </div>
                  </button>
                </li>
              ))}
              {stays !== null && !stays.length && (
                <li className="py-8 text-center text-dim">
                  {q ? `No guest matches "${q}".` : 'No one checked in or reserved right now.'}
                </li>
              )}
            </ul>
          </>
        ) : (
          <>
            <h2 className="mt-3 text-2xl font-bold">Room {stay.rooms?.room_number}</h2>
            <p className="text-dim mt-1">{stay.guests?.full_name}</p>
            <button onClick={() => { setStay(null); setCharged([]) }}
              className="text-dim text-sm underline mt-1">Change guest</button>

            <button onClick={() => setPicking(true)}
              className="mt-6 w-full h-14 rounded-2xl border-2 border-amber text-amber text-lg font-bold">
              + Add item
            </button>

            {pending && (
              <div className="mt-4 rounded-2xl border border-amber bg-surface p-4">
                <div className="font-semibold">{pending.item.name}</div>
                <div className="text-dim text-sm mb-3">from {pending.loc.name}</div>
                <div className="flex items-center gap-3 mb-3">
                  <button onClick={() => setPending(p => ({ ...p, qty: Math.max(1, p.qty - 1) }))}
                    className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">−</button>
                  <input type="number" inputMode="numeric" value={pending.qty}
                    onChange={e => setPending(p => ({ ...p, qty: Math.max(1, Number(e.target.value)) }))}
                    className="h-11 w-16 px-2 rounded-xl bg-raise border border-line tnum text-center" />
                  <button onClick={() => setPending(p => ({ ...p, qty: p.qty + 1 }))}
                    className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">+</button>
                  <input type="number" inputMode="decimal" value={pending.unitPrice}
                    onChange={e => setPending(p => ({ ...p, unitPrice: Number(e.target.value) }))}
                    className="h-11 flex-1 px-3 rounded-xl bg-raise border border-line tnum text-right" />
                </div>
                <button onClick={confirmCharge} disabled={busy}
                  className="w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
                  {busy ? 'Charging…' : `Charge ${naira(pending.qty * pending.unitPrice)} to room`}
                </button>
              </div>
            )}

            {!!charged.length && (
              <div className="mt-6">
                <div className="text-dim mb-2">Charged this session</div>
                <ul className="divide-y divide-line/60">
                  {charged.map((c, i) => (
                    <li key={i} className="py-2 flex items-center gap-3">
                      <span className="flex-1 min-w-0 truncate">{c.qty} × {c.item.name}</span>
                      <span className="tnum text-dim text-sm">{c.loc.name}</span>
                      <span className="tnum font-semibold">{naira(c.qty * c.unitPrice)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {picking && (
        <RoomItemPicker items={items} locations={orderableLocations} stockMap={stockMap}
          onPick={(item, loc) => {
            setPending({ item, loc, qty: 1, unitPrice: Number(item.selling_price) || 0 })
            setPicking(false)
          }}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}
