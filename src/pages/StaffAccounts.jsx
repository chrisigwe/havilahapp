import { useCallback, useEffect, useState } from 'react'
import { SUPERVISOR, is } from '../lib/roles'
import { loadStaffAccounts, resetStaffPassword, deactivateStaff } from '../lib/data'
import { useToast } from '../components/Toast'

// Staff logins, for the GM.
//
// Two different situations, which need opposite actions:
//
//   A PERSONAL login (chidera.mainbar@, kate.frontdesk@) belongs to one
//   person. When they leave, DEACTIVATE it — sign-in requires is_active,
//   so that locks them out immediately whatever their password is, and
//   every database rule checks it too. Changing the password would be
//   weaker: a password can be changed back.
//
//   A ROLE login (chef.awka@, nnewi.auditor@, awka.store@) belongs to
//   the job. The chef leaves, a new chef takes over the SAME account —
//   so it must NOT be deactivated. Change the password and record who
//   holds it now.
//
// The GM's own account is never listed: changing it here could lock the
// only administrator out. The server refuses it too, so the rule does
// not depend on this screen.
export default function StaffAccounts({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [handover, setHandover] = useState(null)
  const [confirmOff, setConfirmOff] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    loadStaffAccounts(staff.branch_id)
      .then(setRows).catch(e => { setRows([]); toast(e.message, 'error') })
  }, [staff.branch_id, toast])
  useEffect(refresh, [refresh])

  if (!is(staff.role, SUPERVISOR)) {
    return <p className="px-5 py-8 text-dim">Staff accounts are for the GM and admin only.</p>
  }

  async function doHandover() {
    if ((handover.password || '').length < 8) {
      toast('Use at least 8 characters', 'error'); return
    }
    setBusy(true)
    try {
      await resetStaffPassword(handover.row.id, handover.password, handover.holder)
      toast(`Password changed for ${handover.row.full_name}`, 'success')
      setHandover(null); refresh()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function doDeactivate() {
    setBusy(true)
    try {
      await deactivateStaff(confirmOff.id)
      toast(`${confirmOff.full_name} can no longer sign in`, 'success')
      setConfirmOff(null); refresh()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  // gm/admin accounts are not listed — see the note above.
  const list = (rows || []).filter(r => !['gm', 'admin'].includes(r.role))

  return (
    <div className="px-5 pb-8">
      <h1 className="text-xl font-bold py-2">Staff accounts</h1>
      <p className="text-dim text-sm mb-3">
        When someone leaves: if the login is theirs alone, switch it off. If it
        belongs to the job and someone else is taking over, change the password.
      </p>

      {rows === null && <p className="text-dim py-8 text-center">Loading…</p>}

      {list.map(r => (
        <div key={r.id} className="py-3 border-b border-line/60">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold truncate">{r.full_name}</span>
            <span className="text-dim text-sm shrink-0 capitalize">
              {r.role.replace('_', ' ')}
            </span>
          </div>
          {r.note && (
            <div className="text-dim text-xs mt-1 whitespace-pre-line">{r.note}</div>
          )}
          <div className="flex gap-2 mt-2">
            <button onClick={() => setHandover({ row: r, password: '', holder: '' })}
              className="h-9 px-3 rounded-lg border border-amber text-amber text-sm font-semibold">
              Hand over / change password
            </button>
            <button onClick={() => setConfirmOff(r)}
              className="h-9 px-3 rounded-lg border border-clay text-clay text-sm font-semibold">
              Switch off
            </button>
          </div>
        </div>
      ))}

      {!!rows && !list.length && (
        <p className="text-dim py-8 text-center">No staff accounts at this branch.</p>
      )}

      {handover && (
        <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
          <div className="px-5 py-6">
            <button onClick={() => setHandover(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">{handover.row.full_name}</h2>
            <p className="text-dim text-sm mt-1">
              The account stays as it is; only the password changes. Use this when
              someone new is taking over the job.
            </p>

            <label className="block text-dim text-sm mt-5">New password</label>
            <input type="text" value={handover.password} autoComplete="off"
              onChange={e => setHandover(h => ({ ...h, password: e.target.value }))}
              className="mt-1 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
            <p className="text-dim text-xs mt-1">
              At least 8 characters. Shown as you type so you can pass it on
              correctly — write it down before saving.
            </p>

            <label className="block text-dim text-sm mt-4">Who is taking it over?</label>
            <input value={handover.holder} placeholder="e.g. Grace Nwosu"
              onChange={e => setHandover(h => ({ ...h, holder: e.target.value }))}
              className="mt-1 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
            <p className="text-dim text-xs mt-1">
              Recorded with today's date. Entries in History name the ACCOUNT, not
              the person, so this is what lets an old entry be read back to whoever
              actually made it.
            </p>

            <button onClick={doHandover} disabled={busy}
              className="mt-6 w-full h-14 rounded-2xl bg-amber text-bg text-lg font-bold disabled:opacity-40">
              {busy ? 'Changing…' : 'Change the password'}
            </button>
            <button onClick={() => setHandover(null)}
              className="mt-2 w-full h-12 text-dim">Cancel</button>
          </div>
        </div>
      )}

      {confirmOff && (
        <div className="fixed inset-0 z-50 bg-bg overflow-y-auto">
          <div className="px-5 py-6">
            <button onClick={() => setConfirmOff(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">Switch off {confirmOff.full_name}?</h2>
            <p className="text-dim mt-3">
              They will not be able to sign in from that moment, whatever their
              password is. Everything they have recorded stays exactly as it is.
            </p>
            <p className="text-amber text-sm mt-3">
              If this login belongs to the JOB rather than the person — a chef or
              store account someone else will take over — change the password
              instead, or the next person cannot get in.
            </p>
            <button onClick={doDeactivate} disabled={busy}
              className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
              {busy ? 'Switching off…' : 'Switch off this account'}
            </button>
            <button onClick={() => setConfirmOff(null)}
              className="mt-2 w-full h-12 text-dim">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
