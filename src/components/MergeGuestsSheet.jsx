import { useEffect, useState } from 'react'
import { searchGuestsForMerge, mergeGuests } from '../lib/data'
import { useToast } from './Toast'

// GM/admin only, enforced server-side by merge_guests() itself — the
// UI gate below is a convenience, not the real security boundary.
// Two-step flow: pick the survivor first (the record worth keeping),
// then pick one or more duplicates to fold into it. Confirms with an
// explicit "this cannot be undone" before calling the RPC, given how
// hard this is to reverse if the wrong two guests get merged.
export default function MergeGuestsSheet({ boot, onClose }) {
  const { staff } = boot
  const toast = useToast()
  const [step, setStep] = useState('survivor') // 'survivor' | 'duplicates' | 'confirm'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [survivor, setSurvivor] = useState(null)
  const [duplicates, setDuplicates] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => {
      searchGuestsForMerge(staff.branch_id, query).then(setResults)
    }, 350)
    return () => clearTimeout(t)
  }, [query, staff.branch_id])

  function toggleDuplicate(g) {
    setDuplicates(d => d.some(x => x.id === g.id) ? d.filter(x => x.id !== g.id) : [...d, g])
  }

  async function confirm() {
    setBusy(true)
    try {
      await mergeGuests(survivor.id, duplicates.map(d => d.id))
      toast(`Merged ${duplicates.length} record${duplicates.length === 1 ? '' : 's'} into ${survivor.full_name}`, 'success')
      onClose()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
      <div className="p-5 max-w-sm mx-auto">
        <button onClick={onClose} className="text-dim">Close</button>
        <h2 className="mt-3 text-2xl font-bold">Merge duplicate guests</h2>

        {step === 'survivor' && (
          <>
            <p className="text-dim mt-2">
              First, find the guest record worth keeping — usually the one
              with the most stay history.
            </p>
            <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search by name"
              className="mt-4 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
            <div className="mt-2 divide-y divide-line">
              {results.map(g => (
                <button key={g.id} onClick={() => { setSurvivor(g); setQuery(''); setResults([]); setStep('duplicates') }}
                  className="block w-full text-left py-3">
                  <div className="font-semibold">{g.full_name}</div>
                  <div className="text-dim text-sm">
                    {g.stayCount} stay{g.stayCount === 1 ? '' : 's'}{g.phone ? ` · ${g.phone}` : ''}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'duplicates' && (
          <>
            <p className="text-dim mt-2">
              Keeping <span className="text-fg font-semibold">{survivor.full_name}</span>.
              Now find every other record that's actually the same person.
            </p>
            <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search by name"
              className="mt-4 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
            <div className="mt-2 divide-y divide-line">
              {results.filter(g => g.id !== survivor.id).map(g => {
                const picked = duplicates.some(x => x.id === g.id)
                return (
                  <button key={g.id} onClick={() => toggleDuplicate(g)}
                    className={`block w-full text-left py-3 ${picked ? 'text-amber' : ''}`}>
                    <div className="font-semibold">{picked ? '✓ ' : ''}{g.full_name}</div>
                    <div className="text-dim text-sm">
                      {g.stayCount} stay{g.stayCount === 1 ? '' : 's'}{g.phone ? ` · ${g.phone}` : ''}
                    </div>
                  </button>
                )
              })}
            </div>
            {!!duplicates.length && (
              <button onClick={() => setStep('confirm')}
                className="mt-6 w-full h-14 rounded-xl bg-amber text-bg font-bold">
                Continue with {duplicates.length} selected
              </button>
            )}
          </>
        )}

        {step === 'confirm' && (
          <>
            <p className="text-dim mt-2">
              Every stay currently on {duplicates.map(d => d.full_name).join(', ')}{' '}
              will move to <span className="text-fg font-semibold">{survivor.full_name}</span>.
              The duplicate record{duplicates.length === 1 ? '' : 's'} stay in the system, clearly
              marked, but stop being used going forward.
            </p>
            <p className="text-clay mt-3 font-semibold">This cannot be undone.</p>
            <button onClick={confirm} disabled={busy}
              className="mt-6 w-full h-16 rounded-2xl bg-clay text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Merging…' : 'Merge now'}
            </button>
            <button onClick={() => setStep('duplicates')} className="mt-3 w-full h-12 text-dim">
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
