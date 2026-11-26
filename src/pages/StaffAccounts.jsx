import { useCallback, useEffect, useState } from 'react'
import { SUPERVISOR, is } from '../lib/roles'
import { loadStaffAccounts, resetStaffPassword, deactivateStaff } from '../lib/data'
import { heldBy, holderOn, otherLines } from '../lib/holders'
import { lagosToday } from '../lib/format'
import { useToast } from '../components/Toast'
import Notice from '../components/Notice'

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
  // Setting rows to empty on failure made the page say "No staff
  // accounts at this branch", which is a statement about the business
  // rather than about a request that failed (20 October 2026).
  const [loadErr, setLoadErr] = useState(null)
  const [handover, setHandover] = useState(null)
  const [confirmOff, setConfirmOff] = useState(null)
  const [busy, setBusy] = useState(false)
  // Empty until somebody asks. A date prefilled with today would
  // answer a question nobody put.
  const [asOf, setAsOf] = useState('')

  const refresh = useCallback(() => {
    loadStaffAccounts(staff.branch_id)
      .then(r => { setRows(r); setLoadErr(null) })
      .catch(e => setLoadErr(e.message || 'could not load'))
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

  const dShort = (d) => (d ? new Date(d + 'T12:00:00')
    .toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

  // One account. Drawn the same whether it is on or off, because the
  // history is the point and a switched-off account still has one.
  const accountRow = (r) => {
    const held = heldBy(r.note)
    const remarks = otherLines(r.note)
    const then = asOf ? holderOn(r.note, asOf) : null
    return (
      <div key={r.id} className="py-3 border-b border-line/60">
        <div className="flex items-baseline justify-between gap-3">
          <span className={`font-semibold truncate ${r.is_active ? '' : 'text-dim'}`}>
            {r.full_name}
          </span>
          <span className="text-dim text-sm shrink-0 capitalize">
            {r.role.replace('_', ' ')}
          </span>
        </div>

        {asOf && (
          <p className={`text-sm mt-1 ${then ? 'text-leaf' : 'text-dim'}`}>
            {then
              ? `On ${dShort(asOf)} this login was held by ${then.name}, since ${dShort(then.since)}.`
              : `No record of who held this on ${dShort(asOf)} — it had not been handed over by then.`}
          </p>
        )}

        {!!held.length && (
          <ul className="mt-1">
            {held.map(h => (
              <li key={h.from} className="text-dim text-xs">
                {h.until
                  ? `${dShort(h.from)} to ${dShort(h.until)} — ${h.name}`
                  : r.is_active
                    ? `${dShort(h.from)} to now — ${h.name}`
                    : `${dShort(h.from)} until it was switched off — ${h.name}`}
                {h.by ? ` · handed over by ${h.by}` : ''}
              </li>
            ))}
          </ul>
        )}

        {!!remarks.length && (
          <div className="text-dim text-xs mt-1 whitespace-pre-line">{remarks.join('\n')}</div>
        )}

        {r.is_active ? (
          /* min-h, not h: at phone width "Hand over / change password"
             wraps to two lines, and a fixed height let the second line
             hang outside the border. */
          <div className="flex flex-wrap gap-2 mt-2">
            <button onClick={() => setHandover({ row: r, password: '', holder: '' })}
              className="min-h-9 px-3 py-1.5 rounded-lg border border-amber text-amber
                         text-sm font-semibold leading-tight">
              Hand over / change password
            </button>
            <button onClick={() => setConfirmOff(r)}
              className="min-h-9 px-3 py-1.5 rounded-lg border border-clay text-clay
                         text-sm font-semibold leading-tight">
              Switch off
            </button>
          </div>
        ) : (
          <p className="text-dim text-xs mt-2">Cannot sign in.</p>
        )}
      </div>
    )
  }

  // gm/admin accounts are not listed — see the note above.
  const all = (rows || []).filter(r => !['gm', 'admin'].includes(r.role))
  const list = all.filter(r => r.is_active)
  const off = all.filter(r => !r.is_active)

  return (
    <div className="px-5 pb-8">
      {/* No heading here: the Shell draws the page title and the staff
          name above every page. */}
      <p className="text-dim text-sm py-2 mb-1">
        When someone leaves: if the login is theirs alone, switch it off. If it
        belongs to the job and someone else is taking over, change the password.
        Never rename an account — every entry it ever made would start naming
        the new person.
      </p>

      {/* An entry names the ACCOUNT. Put the entry's date in here and
          each login below says who was holding it that day. One control
          for the whole page, because the question is always asked while
          looking at something else (26 November 2026). */}
      <div className="rounded-2xl border border-line bg-surface p-4 mb-3">
        <label className="block text-dim text-sm">Reading an old entry? Put its date here</label>
        <input type="date" value={asOf} max={lagosToday()}
          onChange={e => setAsOf(e.target.value)}
          className="mt-1 h-12 w-full px-3 rounded-xl bg-raise border border-line" />
        <p className="text-dim text-xs mt-1">
          Entries name the login, not the person. This says who was holding each
          one on that day.
        </p>
      </div>

      {loadErr && (
        <Notice tone="problem" title="Staff accounts could not be loaded" className="mb-3">
          <p>This does not mean there are none. Tell your developer.</p>
          <p className="text-xs mt-2 break-words">{loadErr}</p>
        </Notice>
      )}

      {!loadErr && !!list.length && (
        <section className="rounded-2xl border border-line bg-surface p-4 mb-3">
          <div className="text-dim text-sm">Logins at this branch</div>
          <div className="tnum text-2xl font-bold">{list.length}</div>
          <div className="text-dim text-sm mt-1">
            Each one can sell, record or approve under the name it carries.
          </div>
        </section>
      )}

      {rows === null && !loadErr && <p className="text-dim py-8 text-center">Loading…</p>}

      {list.map(r => accountRow(r))}

      {/* Switched-off accounts stay on the page. Their history is the
          whole reason to keep them visible. */}
      {!!off.length && (
        <section className="mt-6">
          <h2 className="text-dim text-[0.65rem] uppercase tracking-[0.18em] font-semibold">
            Switched off
          </h2>
          <p className="text-dim text-xs mt-1 mb-1">
            These cannot sign in. They are here because the entries they made are
            still in the books.
          </p>
          {off.map(r => accountRow(r))}
        </section>
      )}

      {!!rows && !loadErr && !list.length && (
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
