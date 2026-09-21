import { useEffect, useState } from 'react'
import { naira, lagosToday, orderableLocations } from '../lib/format'
import { searchLiveStays, chargeItemToRoom, chargeWriteoffToRoom } from '../lib/data'
import RoomItemPicker from './RoomItemPicker'

// Charges items to a hotel room/guest stay — the front desk's own
// side of this (their FolioDrawer) adds one item at a time, each its
// own order, so this matches that exactly: a guest's bill looks the
// same whether it was added here or there.
//
// Two kinds of charge, matching how the rest of the app now treats
// this split: drinks/minimart are real catalog items with tracked
// stock (picked via RoomItemPicker); restaurant orders are typed —
// no catalog item, no stock tracking, since a plate of food isn't a
// countable stock unit.
export default function RoomChargeSheet({ boot, stockMap, onClose, toast }) {
  const { staff, items, allLocations } = boot
  const orderable = orderableLocations(allLocations).filter(l => !/restaurant/i.test(l.name))
  const [q, setQ] = useState('')
  const [stays, setStays] = useState(null)
  const [stay, setStay] = useState(null)
  const [charged, setCharged] = useState([])   // this session's charges
  const [picking, setPicking] = useState(false)
  const [typing, setTyping] = useState(null)    // { description, qty, unitPrice } while composing
  const [pending, setPending] = useState(null)  // { item, loc, qty, unitPrice } confirmed catalog pick
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

  async function confirmTypedCharge() {
    if (!typing || !typing.description.trim() || !Number(typing.unitPrice)) return
    setBusy(true)
    try {
      const desc = typing.description.trim()
      const qty = typing.qty
      const unitPrice = Number(typing.unitPrice)
      // Standard and Staff are both real, paid charges — only
      // PR/Damage is a genuine write-off with nothing collected.
      if (typing.orderType !== 'pr_damage') {
        await chargeItemToRoom({
          staff, stayId: stay.id, description: desc,
          qty, unitPrice, businessDate: lagosToday(),
          orderType: typing.orderType, writeoffNote: typing.writeoffNote,
        })
      } else {
        await chargeWriteoffToRoom({
          staff, stayId: stay.id, description: desc, qty, unitPrice, businessDate: lagosToday(),
          orderType: typing.orderType, damageReason: typing.damageReason, writeoffNote: typing.writeoffNote,
        })
      }
      setCharged(c => [{ description: desc, qty, unitPrice, typed: true,
                         orderType: typing.orderType, at: Date.now() }, ...c])
      toast(typing.orderType !== 'pr_damage'
        ? `${qty} × ${desc} charged to Room ${stay.rooms?.room_number}`
        : `${qty} × ${desc} recorded — not paid for`, 'success')
      setTyping(null)
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
              + Add a drink or minimart item
            </button>
            <button onClick={() => setTyping({ description: '', qty: 1, unitPrice: '',
              orderType: 'standard', damageReason: null, writeoffNote: '' })}
              className="mt-3 w-full h-14 rounded-2xl border-2 border-line text-ink text-lg font-bold">
              + Add a restaurant order
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

            {typing && (
              <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
                <div className="text-dim text-sm mb-2">Typed, not tracked as stock</div>
                <input value={typing.description} autoFocus
                  onChange={e => setTyping(t => ({ ...t, description: e.target.value }))}
                  placeholder="e.g. Jollof Rice with Chicken"
                  className="h-12 w-full px-3 mb-3 rounded-xl bg-raise border border-line placeholder:text-dim" />
                <div className="flex items-center gap-3 mb-3">
                  <button onClick={() => setTyping(t => ({ ...t, qty: Math.max(1, t.qty - 1) }))}
                    className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">−</button>
                  <input type="number" inputMode="numeric" value={typing.qty}
                    onChange={e => setTyping(t => ({ ...t, qty: Math.max(1, Number(e.target.value)) }))}
                    className="h-11 w-16 px-2 rounded-xl bg-raise border border-line tnum text-center" />
                  <button onClick={() => setTyping(t => ({ ...t, qty: t.qty + 1 }))}
                    className="h-11 w-11 rounded-xl bg-raise border border-line text-xl font-bold">+</button>
                  <input type="number" inputMode="decimal" value={typing.unitPrice}
                    onChange={e => setTyping(t => ({ ...t, unitPrice: e.target.value }))}
                    placeholder="price per plate"
                    className="h-11 flex-1 px-3 rounded-xl bg-raise border border-line tnum text-right placeholder:text-dim" />
                </div>

                <div className="flex gap-2 mb-3">
                  {[['standard', 'Standard'], ['pr_damage', 'PR / Damage'], ['staff', 'Staff']].map(([k, label]) => (
                    <button key={k} onClick={() => setTyping(t => ({ ...t, orderType: k }))}
                      className={`flex-1 h-10 rounded-lg border text-sm font-semibold ${typing.orderType === k
                        ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                      {label}
                    </button>
                  ))}
                </div>

                {typing.orderType === 'pr_damage' && (
                  <>
                    <select value={typing.damageReason || ''}
                      onChange={e => setTyping(t => ({ ...t, damageReason: e.target.value || null }))}
                      className="h-11 w-full px-3 mb-2 rounded-xl bg-raise border border-line">
                      <option value="">Not damage — PR only</option>
                      <option value="breakage">Breakage</option>
                      <option value="expiry">Expiry</option>
                      <option value="spillage">Spillage</option>
                      <option value="theft">Theft</option>
                      <option value="spoilage">Spoilage</option>
                      <option value="other">Other</option>
                    </select>
                    <input value={typing.writeoffNote}
                      onChange={e => setTyping(t => ({ ...t, writeoffNote: e.target.value }))}
                      placeholder="Who approved this / note"
                      className="h-11 w-full px-3 mb-3 rounded-xl bg-raise border border-line placeholder:text-dim" />
                  </>
                )}
                {typing.orderType === 'staff' && (
                  <input value={typing.writeoffNote}
                    onChange={e => setTyping(t => ({ ...t, writeoffNote: e.target.value }))}
                    placeholder="Note (optional)"
                    className="h-11 w-full px-3 mb-3 rounded-xl bg-raise border border-line placeholder:text-dim" />
                )}

                <button onClick={confirmTypedCharge}
                  disabled={busy || !typing.description.trim() || !Number(typing.unitPrice)}
                  className="w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
                  {busy ? 'Saving…' : typing.orderType !== 'pr_damage'
                    ? `Charge ${naira((typing.qty || 0) * (Number(typing.unitPrice) || 0))} to room`
                    : 'Save — not paid for'}
                </button>
              </div>
            )}

            {!!charged.length && (
              <div className="mt-6">
                <div className="text-dim mb-2">Charged this session</div>
                <ul className="divide-y divide-line/60">
                  {charged.map((c, i) => (
                    <li key={i} className="py-2 flex items-center gap-3">
                      <span className="flex-1 min-w-0 truncate">
                        {c.qty} × {c.item?.name || c.description}
                        {c.orderType === 'pr_damage' && <span className="text-clay text-sm"> · PR/Damage</span>}
                        {c.orderType === 'staff' && <span className="text-amber text-sm"> · Staff</span>}
                      </span>
                      <span className="tnum text-dim text-sm">{c.typed ? 'Restaurant' : c.loc.name}</span>
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
        <RoomItemPicker items={items} locations={orderable} stockMap={stockMap}
          onPick={(item, loc) => {
            setPending({ item, loc, qty: 1, unitPrice: Number(item.selling_price) || 0 })
            setPicking(false)
          }}
          onClose={() => setPicking(false)} />
      )}
    </div>
  )
}
