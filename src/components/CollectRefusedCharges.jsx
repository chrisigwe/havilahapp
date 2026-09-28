import { useCallback, useEffect, useState } from 'react'
import { naira, methodLabel } from '../lib/format'
import { loadRoomChargesByStatus, collectRejectedRoomCharge } from '../lib/data'
import { useToast } from './Toast'
import CustomerPicker from './CustomerPicker'

// Room charges the front desk refused. The drinks were already served,
// so the bar has to collect another way — POS, Cash, Credit or Split.
//
// Collecting goes through ONE database function that creates the sale
// and releases the room charge's stock together, so each bottle is
// deducted exactly once and the money lands in today's cash-up.
//
// Listed for the whole branch, not just this department: refusals are
// rare, and a short list anyone at the bar can act on beats hiding one
// because it was rung up at the other counter.
export default function CollectRefusedCharges({
  branchId, locationId, methods, customers, onCreateCustomer, onCollected,
}) {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [collecting, setCollecting] = useState(null)
  const [mode, setMode] = useState('single')        // 'single' | 'split'
  const [method, setMethod] = useState(null)
  const [split, setSplit] = useState({})
  const [customerId, setCustomerId] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    loadRoomChargesByStatus(branchId, 'rejected').then(setRows).catch(() => setRows([]))
  }, [branchId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 60000)
    return () => clearInterval(id)
  }, [refresh])

  function open(r) {
    setCollecting(r); setMode('single'); setMethod(null); setSplit({}); setCustomerId(null)
  }

  const total = collecting?.total || 0
  const payments = mode === 'single'
    ? (method ? [{ method, amount: total }] : [])
    : methods.map(m => ({ method: m, amount: Number(split[m] || 0) })).filter(p => p.amount > 0)
  const allocated = payments.reduce((t, p) => t + p.amount, 0)
  const credit = payments.filter(p => p.method === 'credit').reduce((t, p) => t + p.amount, 0)
  const balanced = Math.abs(allocated - total) < 0.01
  const ready = balanced && payments.length > 0 && (credit === 0 || !!customerId)

  async function collect() {
    setBusy(true)
    try {
      await collectRejectedRoomCharge({
        orderId: collecting.id, payments, customerId, locationId,
      })
      toast(`Collected ${naira(total)} · Room ${collecting.room}`, 'success')
      setCollecting(null); refresh(); onCollected?.()
    } catch (e) { toast('Not collected: ' + e.message, 'error') }
    setBusy(false)
  }

  if (!rows?.length) return null

  return (
    <div className="mt-3 rounded-2xl border-2 border-clay bg-surface p-4">
      <p className="font-semibold text-clay">Room charges refused by front desk</p>
      <p className="text-dim text-xs mt-1 mb-2">
        These were served but won't go on the room bill. Collect payment from the guest.
      </p>

      {rows.map(r => (
        <div key={r.id} className="py-3 border-t border-line/60 first:border-0">
          <div className="flex justify-between gap-2">
            <span className="font-semibold truncate">Room {r.room} · {r.guest}</span>
            <span className="tnum font-bold shrink-0">{naira(r.total)}</span>
          </div>
          {r.note && <div className="text-clay text-xs mt-0.5">Refused: {r.note}</div>}
          <div className="text-dim text-xs mt-0.5">
            {r.servedBy && <>by {r.servedBy} · </>}
            {r.items.map(i => `${i.description} ×${Number(i.qty)}`).join(', ')}
          </div>

          {collecting?.id === r.id ? (
            <div className="mt-3">
              <div className="flex gap-2 mb-3">
                {['single', 'split'].map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`flex-1 h-9 rounded-lg border text-sm font-semibold ${mode === m
                      ? 'bg-amber text-bg border-amber' : 'border-line text-dim'}`}>
                    {m === 'single' ? 'One method' : 'Split'}
                  </button>
                ))}
              </div>

              {mode === 'single' ? (
                <div className="grid grid-cols-3 gap-2">
                  {methods.map(m => (
                    <button key={m} onClick={() => setMethod(m)}
                      className={`h-11 rounded-lg border font-semibold text-sm ${method === m
                        ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
                      {methodLabel[m] || m}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {methods.map(m => (
                    <div key={m} className="flex items-center gap-3">
                      <span className="w-16 text-dim text-sm">{methodLabel[m] || m}</span>
                      <input type="number" inputMode="decimal" placeholder="0" value={split[m] || ''}
                        onChange={e => setSplit(s => ({ ...s, [m]: e.target.value }))}
                        className="h-11 flex-1 px-3 rounded-lg bg-raise border border-line tnum" />
                    </div>
                  ))}
                  <div className={`text-sm tnum ${balanced ? 'text-leaf' : 'text-clay'}`}>
                    {naira(allocated)} of {naira(total)}
                  </div>
                </div>
              )}

              {credit > 0 && (
                <div className="mt-3">
                  <div className="text-dim text-sm mb-1">Customer (required for credit)</div>
                  <CustomerPicker customers={customers} value={customerId}
                    onPick={setCustomerId}
                    onCreate={async (name, servedBy) => {
                      const c = await onCreateCustomer(name, servedBy)
                      if (c) setCustomerId(c.id)
                    }} />
                </div>
              )}

              <div className="flex gap-2 mt-3">
                <button onClick={collect} disabled={!ready || busy}
                  className="flex-1 h-11 rounded-lg bg-amber text-bg font-bold disabled:opacity-40">
                  {busy ? 'Collecting…' : `Collect ${naira(total)}`}
                </button>
                <button onClick={() => setCollecting(null)}
                  className="h-11 px-4 rounded-lg border border-line text-dim">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => open(r)}
              className="mt-2 w-full h-10 rounded-lg border border-clay text-clay font-semibold text-sm">
              Collect payment
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
