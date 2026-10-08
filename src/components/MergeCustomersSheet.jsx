import { useEffect, useMemo, useState } from 'react'
import { loadCustomerAccountsForMerge, mergeCustomers } from '../lib/data'
import { naira } from '../lib/format'
import { useToast } from './Toast'

// GM/admin only, enforced server-side by merge_customers() itself.
// For credit accounts the automatic finder cannot pair, e.g. "Auditor
// chioma" and "Chioma (staff)". Pick the account to KEEP first, then the
// one to fold into it. Both are in this branch only.
export default function MergeCustomersSheet({ boot, onClose }) {
  const { staff } = boot
  const toast = useToast()
  const [all, setAll] = useState(null)
  const [step, setStep] = useState('keep') // keep | merge | confirm
  const [query, setQuery] = useState('')
  const [keep, setKeep] = useState(null)
  const [dup, setDup] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadCustomerAccountsForMerge(staff.branch_id).then(setAll).catch(e => {
      toast('Could not load accounts: ' + e.message, 'error'); setAll([])
    })
  }, [staff.branch_id])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (all || [])
      .filter(c => !keep || c.id !== keep.id)
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .slice(0, 40)
  }, [all, query, keep])

  async function confirm() {
    setBusy(true)
    try {
      await mergeCustomers(keep.id, [dup.id])
      toast(`Merged "${dup.name}" into "${keep.name}"`, 'success')
      onClose()
    } catch (e) { toast('Not merged: ' + e.message, 'error') }
    setBusy(false)
  }

  const Row = ({ c, onPick }) => (
    <button onClick={() => onPick(c)} className="block w-full text-left py-3">
      <div className="font-semibold">{c.name}</div>
      <div className="text-dim text-sm tnum">{naira(c.balance)} owing</div>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="p-5 max-w-sm mx-auto">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">Merge two credit accounts</h2>

        {step !== 'confirm' && (
          <>
            <p className="text-dim mt-2">
              {step === 'keep'
                ? 'First pick the account to KEEP. If one is linked to payroll, keep that one.'
                : <>Keeping <span className="text-fg font-semibold">{keep.name}</span>. Now pick the other account for the same person. It will be closed.</>}
            </p>
            <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search by name"
              className="mt-4 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
            {all === null && <p className="text-dim mt-4">Loading…</p>}
            <div className="mt-2 divide-y divide-line">
              {shown.map(c => (
                <Row key={c.id} c={c} onPick={x => {
                  setQuery('')
                  if (step === 'keep') { setKeep(x); setStep('merge') }
                  else { setDup(x); setStep('confirm') }
                }} />
              ))}
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
              <div className="text-dim text-sm">Keeping</div>
              <div className="font-semibold">{keep.name}</div>
              <div className="text-dim text-sm tnum">{naira(keep.balance)} owing</div>
              <div className="text-dim text-sm mt-3">Merging in and closing</div>
              <div className="font-semibold text-clay">{dup.name}</div>
              <div className="text-dim text-sm tnum">{naira(dup.balance)} owing</div>
              <div className="text-dim text-sm mt-3">Combined balance afterwards</div>
              <div className="tnum text-xl font-bold text-clay">{naira(keep.balance + dup.balance)}</div>
            </div>
            <p className="text-dim text-sm mt-4">
              Every sale and repayment under "{dup.name}" moves onto "{keep.name}".
              The old account is closed and renamed, not deleted.
            </p>
            <p className="text-clay mt-3 font-semibold">
              This moves real money between accounts. Be sure they are the same person.
            </p>
            <button onClick={confirm} disabled={busy}
              className="mt-6 w-full h-16 rounded-2xl bg-clay text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Merging…' : 'Merge now'}
            </button>
            <button onClick={() => { setDup(null); setStep('merge') }} className="mt-3 w-full h-12 text-dim">
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
