import { useCallback, useEffect, useState } from 'react'
import { loadHandoverNotes, addHandoverNote, ackHandoverNote } from '../lib/data'
import { useToast } from './Toast'

// Short notes between shifts for one department: "Fanta is low", "Room 205 owes 5,000".
// The next person taps "Got it"; notes disappear after 3 days.
export default function HandoverNotes({ branchId, locationId }) {
  const toast = useToast()
  const [notes, setNotes] = useState(null)
  const [text, setText] = useState('')
  const [writing, setWriting] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!branchId || !locationId) return
    loadHandoverNotes(branchId, locationId).then(setNotes).catch(() => setNotes([]))
  }, [branchId, locationId])
  useEffect(refresh, [refresh])

  async function send() {
    if (!text.trim()) return
    setBusy(true)
    try { await addHandoverNote(branchId, locationId, text); setText(''); setWriting(false); refresh() }
    catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }
  async function ack(id) {
    try { await ackHandoverNote(id); refresh() } catch (e) { toast(e.message, 'error') }
  }

  const open = (notes || []).filter(n => !n.acked)
  const done = (notes || []).filter(n => n.acked)
  const time = t => new Date(t).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="mt-4">
      {open.map(n => (
        <div key={n.id} className="mb-2 rounded-2xl border border-amber bg-surface p-3">
          <div className="text-xs text-dim">Handover from {n.mine ? 'you' : n.author} · {time(n.at)}</div>
          <p className="mt-1">{n.body}</p>
          {!n.mine && (
            <button onClick={() => ack(n.id)}
              className="mt-2 h-10 px-4 rounded-lg border border-amber text-amber text-sm font-semibold">Got it</button>
          )}
        </div>
      ))}
      {!!done.length && (
        <p className="text-dim text-xs mb-2">{done.length} earlier note{done.length > 1 ? 's' : ''} read by {done[0].acked_by || 'someone'}.</p>
      )}
      {writing ? (
        <div className="rounded-2xl border border-line bg-surface p-3">
          <textarea value={text} onChange={e => setText(e.target.value)} maxLength={500} rows={3} autoFocus
            placeholder="Tell the next shift: stock running low, who owes, anything unusual"
            className="w-full p-3 rounded-xl bg-raise border border-line" />
          <div className="mt-2 flex gap-2">
            <button onClick={send} disabled={busy || !text.trim()}
              className="flex-1 h-11 rounded-xl bg-amber text-bg font-bold disabled:opacity-40">Leave note</button>
            <button onClick={() => { setWriting(false); setText('') }}
              className="h-11 px-4 rounded-xl border border-line text-dim">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setWriting(true)}
          className="w-full h-11 rounded-xl border border-line text-dim font-semibold text-sm">
          Leave a note for the next shift
        </button>
      )}
    </section>
  )
}
