import { useState } from 'react'
import { saveWriteoff } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import { lagosToday } from '../lib/format'

// Self-contained PR/damage sheet used from both the Sales screen and
// (for the auditor) the Stock screen. One definition so the two entry
// points can't drift apart on reason fields or validation.
export default function WriteoffSheet({ staff, item, locationId, onClose, onSaved, toast }) {
  const [kind, setKind] = useState('damage')
  const [qty, setQty] = useState(1)
  const [unitValue, setUnitValue] = useState(Number(item.selling_price) || 0)
  const [note, setNote] = useState('')
  const [damageReason, setDamageReason] = useState(null)
  const [date, setDate] = useState(lagosToday())
  const [busy, setBusy] = useState(false)

  async function commit() {
    if (kind === 'damage' && !damageReason) return
    setBusy(true)
    const payload = { staffLite: { id: staff.id, branch_id: staff.branch_id },
      itemId: item.id, locationId, kind, qty, unitValue, date,
      note: note || null, damageReason: kind === 'damage' ? (damageReason || null) : null }
    try {
      try {
        await saveWriteoff({ staff, item, locationId, kind, qty, unitValue, date,
          note: note || null, damageReason: kind === 'damage' ? (damageReason || null) : null })
        toast(`${qty} × ${item.name} recorded as ${kind === 'damage' ? 'damaged' : 'PR'}`, 'success')
      } catch (e) {
        if (!isConnectionError(e)) throw e
        enqueue({ kind: 'writeoff', payload })
        toast('No connection — saved and will send when you are back online')
      }
      onSaved?.(); onClose(); flush()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col">
      <div className="p-5 flex-1 overflow-y-auto">
        <button onClick={onClose} className="text-dim">Back</button>
        <div className="mt-3">
          <h2 className="text-2xl font-bold">{item.name}</h2>
          <p className="text-dim mt-1">Not a sale — this leaves stock without income.</p>

          <Row label="Reason">
            <Chip active={kind === 'complimentary'} onClick={() => setKind('complimentary')}>PR / free</Chip>
            <Chip active={kind === 'damage'} onClick={() => setKind('damage')}>Damaged</Chip>
          </Row>
          <Row label="Quantity">
            <button onClick={() => setQty(q => Math.max(1, q - 1))}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">−</button>
            <span className="tnum text-3xl font-bold w-14 text-center">{qty}</span>
            <button onClick={() => setQty(q => q + 1)}
              className="h-14 w-14 rounded-xl bg-surface border border-line text-2xl">+</button>
          </Row>
          <Row label="Value per unit">
            <input type="number" inputMode="decimal" value={unitValue}
              onChange={e => setUnitValue(Number(e.target.value))}
              className="h-12 w-36 px-3 rounded-xl bg-surface border border-line tnum" />
          </Row>
          <Row label="Date">
            <input type="date" value={date} max={lagosToday()}
              onChange={e => setDate(e.target.value)}
              className="h-12 px-3 rounded-xl bg-surface border border-line tnum" />
          </Row>
          {kind === 'damage' && (
            <Row label="What happened">
              <select value={damageReason || ''}
                onChange={e => setDamageReason(e.target.value || null)}
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
          <Row label={kind === 'complimentary' ? 'Authorized by / note' : 'Note (optional)'}>
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder={kind === 'complimentary' ? 'e.g. approved by GM for…' : 'any detail'}
              className="h-12 w-full px-3 rounded-xl bg-surface border border-line placeholder:text-dim" />
          </Row>
          {kind === 'damage' && !damageReason && (
            <p className="text-dim text-sm mt-2">Pick a reason so damage can be tracked by cause.</p>
          )}
          <button onClick={commit} disabled={busy || (kind === 'damage' && !damageReason)}
            className="mt-8 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {busy ? 'Saving…' : 'Save write-off'}
          </button>
        </div>
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
