import { useCallback, useEffect, useMemo, useState } from 'react'
import { naira, lagosToday, methodLabel } from '../lib/format'
import { loadSponsors, loadSponsorAccount, saveSponsorPayment, saveRebatePayout } from '../lib/data'
import { sponsorStanding, sponsorTotals, byMonth, rebateOwed } from '../lib/sponsor'
import { sponsorStatementPdf, savePdf } from '../lib/pdfSheet'
import { useToast } from '../components/Toast'
import FoldedDays from '../components/FoldedDays'

// An organisation that pays for other people's stays — UNIZIK at Awka
// being the first (Chris, 25 November 2026).
//
// The page is one subtraction and says so: paid in, drawn out, what is
// left. There is no table of charges behind it. A draw is the folio
// PAYMENT of method 'sponsor', so the figure here can never disagree
// with the bill the guest signed, and a stay still open draws nothing
// until it is settled.
//
// The card has three states and the wording, not just the colour,
// changes between them. The debt wording deliberately echoes the Credit
// page ("owed", "since") so the first time an account tips nobody has
// to learn a new vocabulary for it.
//
// GM and admin only, in More and in the row policies both.

const TONE = {
  funds: { ring: 'border-leaf/40', ink: 'text-leaf', label: 'In funds' },
  low: { ring: 'border-amber/50', ink: 'text-amber', label: 'Running low' },
  debt: { ring: 'border-clay/50', ink: 'text-clay', label: 'Owed to us' },
}

export default function Sponsors({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [accounts, setAccounts] = useState(null)
  const [pickedId, setPickedId] = useState(null)
  const [account, setAccount] = useState(null)
  const [errList, setErrList] = useState(false)
  const [errAccount, setErrAccount] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)
  const [feeDraft, setFeeDraft] = useState(null)

  const branchId = staff.branch_id
  // Worded exactly as Recovery words a day, so the two pages read the
  // same way: a raw 2026-11-18 is a column heading, not a date anyone
  // reads aloud.
  const dayLabel = (d) => (d ? new Date(d + 'T12:00:00')
    .toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : '')
  const shortDay = (d) => (d ? new Date(d + 'T12:00:00')
    .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }) : '—')
  const today = lagosToday()

  useEffect(() => {
    let alive = true
    setAccounts(null); setAccount(null); setErrList(false)
    loadSponsors(branchId)
      .then(rows => { if (!alive) return; setAccounts(rows); setPickedId(p => p || rows[0]?.id || null) })
      .catch(() => { if (alive) { setAccounts([]); setErrList(true) } })
    return () => { alive = false }
  }, [branchId])

  // The account row's own id, which the fee payouts hang off. Kept as
  // a callback so refresh() does not rebuild on every render.
  const accountIdFor = useCallback(
    (guestId) => (accounts || []).find(a => a.id === guestId)?.accountId || null,
    [accounts])

  const refresh = useCallback(() => {
    if (!pickedId) return
    let alive = true
    setAccount(null); setErrAccount(false)
    loadSponsorAccount(branchId, pickedId, accountIdFor(pickedId))
      .then(a => { if (alive) setAccount(a) })
      .catch(() => { if (alive) { setAccount(null); setErrAccount(true) } })
    return () => { alive = false }
  }, [branchId, pickedId, accountIdFor])

  useEffect(() => { refresh() }, [refresh])

  const picked = (accounts || []).find(a => a.id === pickedId) || null
  const paidIn = account?.paidIn || []
  const payouts = account?.payouts || []
  const draws = account?.draws || []

  const standing = useMemo(
    () => sponsorStanding({ paidIn, drawn: draws, today, money: naira }),
    [paidIn, draws, today])
  const totals = useMemo(() => sponsorTotals(paidIn, draws), [paidIn, draws])
  const months = useMemo(() => byMonth(draws), [draws])
  // Only room draws carry a stay and a night count. Handing meals to
  // rebateOwed would be handing it rows whose nights are zero.
  const roomDraws = useMemo(() => draws.filter(d => d.kind !== 'meal'), [draws])
  const mealDraws = useMemo(() => draws.filter(d => d.kind === 'meal'), [draws])
  const fee = useMemo(
    () => rebateOwed({ draws: roomDraws, perNight: picked?.rebatePerNight || 0, payouts }),
    [roomDraws, picked, payouts])

  // FoldedDays folds a day-grouped list; the month headings come from
  // the fold itself, so the page hands it days and nothing more.
  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of draws) {
      if (!m.has(r.business_date)) m.set(r.business_date, [])
      m.get(r.business_date).push(r)
    }
    return [...m.entries()]
  }, [draws])

  const makeStatement = async () => {
    if (!picked) return
    setBusy(true)
    try {
      await savePdf(sponsorStatementPdf({
        accountName: picked.name,
        branchName: boot.branchName || '',
        balance: totals.balance,
        paidTotal: totals.paid,
        drawnTotal: totals.used,
        covers: 'Room, meals and over-stay. Drinks and minimart are the guest’s own.',
        paidIn: paidIn.map(p => ({
          date: p.paid_on, method: methodLabel[p.method] || p.method,
          note: p.note || '', amount: p.amount,
        })),
        draws: draws.map(r => ({
          date: r.business_date, guest: r.guest_name, roomNo: r.room_number,
          nights: r.kind === 'meal' ? '' : r.nights,
          room: r.kind === 'meal' ? 0 : r.room_charge,
          overstay: r.kind === 'meal' ? 0 : r.overstay_charge,
          meals: r.kind === 'meal' ? r.amount : r.orders_charge,
          amount: r.amount,
        })),
      }), `${picked.name} statement ${today}`)
    } catch (e) {
      toast(e.message || 'The statement could not be made.')
    } finally { setBusy(false) }
  }

  const recordPayment = async () => {
    if (!picked || !draft) return
    setBusy(true)
    try {
      await saveSponsorPayment({
        staff, sponsorGuestId: picked.id, paidOn: draft.paidOn,
        amount: draft.amount, method: draft.method, note: draft.note, ref: draft.ref,
      })
      setDraft(null)
      toast('Payment recorded.')
      const rows = await loadSponsors(branchId)
      setAccounts(rows)
      refresh()
    } catch (e) {
      toast(e.message || 'That payment was not saved.')
    } finally { setBusy(false) }
  }

  const recordPayout = async () => {
    if (!picked?.accountId || !feeDraft) return
    setBusy(true)
    try {
      await saveRebatePayout({
        staff, accountId: picked.accountId, paidOn: feeDraft.paidOn,
        amount: feeDraft.amount, method: feeDraft.method,
        note: feeDraft.note, ref: feeDraft.ref,
      })
      setFeeDraft(null)
      toast('Recorded.')
      refresh()
    } catch (e) {
      toast(e.message || 'That was not saved.')
    } finally { setBusy(false) }
  }

  if (accounts === null) return <p className="px-5 text-dim py-10 text-center">Loading…</p>

  if (errList && !accounts.length) return (
    <p className="px-5 text-clay py-10 text-center">
      The accounts could not be loaded. Nothing has been lost — try again in a moment.
    </p>
  )

  if (!accounts.length) return (
    <div className="px-5 py-10 text-center">
      <p className="text-dim max-w-sm mx-auto">
        No organisation account yet. These are for a company or institution that pays
        for its people’s stays — their guests check in as normal and the stays are
        billed to the account.
      </p>
    </div>
  )

  const tone = TONE[standing.tone] || TONE.funds

  // px-5 to match every other page. The Shell draws the page's title
  // and the staff name above this (its hv-large-title block), so a
  // heading here would be the same word twice -- which is what Chris
  // saw on 25 November.
  return (
    <div className="px-5 pb-10">
      {accounts.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
          {accounts.map(a => (
            <button key={a.id} onClick={() => setPickedId(a.id)}
              className={`shrink-0 px-4 py-2 rounded-full border text-sm whitespace-nowrap ${
                a.id === pickedId ? 'bg-amber text-bg border-amber font-semibold'
                                  : 'border-line text-dim'}`}>
              {a.name}
            </button>
          ))}
        </div>
      )}

      {errAccount ? (
        <p className="text-clay py-10 text-center">
          This account could not be loaded, so no figure is shown rather than a
          wrong one. Nothing has been lost — try again in a moment.
        </p>
      ) : account === null ? (
        <p className="text-dim py-10 text-center">Loading…</p>
      ) : (
        <>
          {/* The headline. One figure, and a sentence that answers the
              question anyone actually has: when do we write to them. */}
          <section className={`mt-2 rounded-2xl border ${tone.ring} bg-surface p-4`}>
            <span className="block text-dim text-[0.65rem] uppercase tracking-[0.18em] font-semibold">
              {picked?.name}
            </span>
            <p className={`mt-1 text-4xl font-extrabold tnum ${tone.ink}`}>{standing.headline}</p>
            <p className="text-dim mt-1">{standing.detail}</p>

            <div className="mt-3 pt-3 border-t border-line flex items-baseline justify-between gap-3 text-sm">
              <span className="text-dim">Paid in</span>
              <span className="tnum font-semibold">{naira(totals.paid)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-dim">
                {roomDraws.length} {roomDraws.length === 1 ? 'stay' : 'stays'}
                {mealDraws.length > 0 && ` · ${mealDraws.length} ${mealDraws.length === 1 ? 'meal' : 'meals'}`}
              </span>
              <span className="tnum font-semibold">{naira(totals.used)}</span>
            </div>

            <div className="mt-4 flex gap-2">
              <button onClick={makeStatement} disabled={busy}
                className="flex-1 py-2.5 rounded-xl border border-line text-sm font-semibold disabled:opacity-50">
                Statement
              </button>
              <button
                onClick={() => setDraft({ paidOn: today, amount: '', method: 'transfer',
                                          note: '', ref: crypto.randomUUID() })}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-amber text-bg text-sm font-semibold disabled:opacity-50">
                Record a payment
              </button>
            </div>
          </section>

          {draft && (
            <section className="mt-3 rounded-2xl border border-line bg-surface p-4">
              <h2 className="font-semibold">Money received from {picked?.name}</h2>
              <label className="block mt-3 text-sm text-dim">How much</label>
              <input inputMode="decimal" value={draft.amount}
                onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))}
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line tnum" />
              <label className="block mt-3 text-sm text-dim">Day it arrived</label>
              <input type="date" value={draft.paidOn} max={today}
                onChange={e => setDraft(d => ({ ...d, paidOn: e.target.value }))}
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line" />
              <div className="mt-3 flex gap-2">
                {['transfer', 'pos', 'cash'].map(m => (
                  <button key={m} onClick={() => setDraft(d => ({ ...d, method: m }))}
                    className={`flex-1 py-2 rounded-xl border text-sm capitalize ${
                      draft.method === m ? 'bg-amber text-bg border-amber font-semibold'
                                         : 'border-line text-dim'}`}>
                    {m}
                  </button>
                ))}
              </div>
              <label className="block mt-3 text-sm text-dim">Note (optional)</label>
              <input value={draft.note}
                onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
                placeholder="Reference, who sent it"
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line" />
              <div className="mt-4 flex gap-2">
                <button onClick={() => setDraft(null)} disabled={busy}
                  className="flex-1 py-2.5 rounded-xl border border-line text-sm">Cancel</button>
                <button onClick={recordPayment} disabled={busy || !(Number(draft.amount) > 0)}
                  className="flex-1 py-2.5 rounded-xl bg-leaf text-bg text-sm font-semibold disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </section>
          )}

          {/* Owed by Havilah for the nights drawn, not by the
              organisation — which is why it is a card of its own and
              why nothing here reaches the statement. */}
          {picked?.rebatePerNight > 0 && (
            <section className="mt-3 rounded-2xl border border-line bg-surface p-4">
              <span className="block text-dim text-[0.65rem] uppercase tracking-[0.18em] font-semibold">
                Owed to {picked.rebatePayee || 'the agreed payee'}
              </span>
              <p className={`mt-1 text-3xl font-extrabold tnum ${fee.owed > 0.009 ? 'text-amber' : 'text-dim'}`}>
                {naira(Math.abs(fee.owed))}{fee.owed < -0.009 ? ' over' : ''}
              </p>
              <p className="text-dim mt-1 text-sm">
                {fee.nights} {fee.nights === 1 ? 'night' : 'nights'} across {fee.stays}{' '}
                {fee.stays === 1 ? 'stay' : 'stays'} at {naira(fee.rate)} a night
                {fee.paid > 0.009 ? ` · ${naira(fee.paid)} already paid` : ''}
              </p>
              <p className="text-dim mt-2 text-xs">
                Ours to pay, not the organisation’s. It is not on their statement.
              </p>
              <button
                onClick={() => setFeeDraft({ paidOn: today, amount: '', method: 'cash',
                                             note: '', ref: crypto.randomUUID() })}
                disabled={busy}
                className="mt-3 w-full py-2.5 rounded-xl border border-line text-sm font-semibold disabled:opacity-50">
                Record a payment to {picked.rebatePayee || 'them'}
              </button>
            </section>
          )}

          {feeDraft && (
            <section className="mt-3 rounded-2xl border border-line bg-surface p-4">
              <h2 className="font-semibold">Paid to {picked?.rebatePayee || 'the payee'}</h2>
              <label className="block mt-3 text-sm text-dim">How much</label>
              <input inputMode="decimal" value={feeDraft.amount}
                onChange={e => setFeeDraft(d => ({ ...d, amount: e.target.value }))}
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line tnum" />
              <label className="block mt-3 text-sm text-dim">Day it was paid</label>
              <input type="date" value={feeDraft.paidOn} max={today}
                onChange={e => setFeeDraft(d => ({ ...d, paidOn: e.target.value }))}
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line" />
              <div className="mt-3 flex gap-2">
                {['cash', 'transfer', 'pos'].map(m => (
                  <button key={m} onClick={() => setFeeDraft(d => ({ ...d, method: m }))}
                    className={`flex-1 py-2 rounded-xl border text-sm capitalize ${
                      feeDraft.method === m ? 'bg-amber text-bg border-amber font-semibold'
                                            : 'border-line text-dim'}`}>
                    {m}
                  </button>
                ))}
              </div>
              <label className="block mt-3 text-sm text-dim">Note (optional)</label>
              <input value={feeDraft.note}
                onChange={e => setFeeDraft(d => ({ ...d, note: e.target.value }))}
                placeholder="What it covers"
                className="w-full mt-1 px-3 py-2.5 rounded-xl bg-raise border border-line" />
              <div className="mt-4 flex gap-2">
                <button onClick={() => setFeeDraft(null)} disabled={busy}
                  className="flex-1 py-2.5 rounded-xl border border-line text-sm">Cancel</button>
                <button onClick={recordPayout} disabled={busy || !(Number(feeDraft.amount) > 0)}
                  className="flex-1 py-2.5 rounded-xl bg-leaf text-bg text-sm font-semibold disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </section>
          )}

          {!draws.length ? (
            <p className="text-dim py-10 text-center">
              Nothing has been drawn against this account yet.
            </p>
          ) : (
            <FoldedDays groups={byDay} today={today} eyebrow="Drawn in"
              summary={(items) => (
                <span className="tnum text-2xl font-extrabold text-amber">
                  {naira(items.reduce((t, r) => t + Number(r.amount || 0), 0))}
                </span>
              )}
              renderDay={(day, items) => (
                <section key={day} className="mt-3 rounded-2xl border border-line bg-surface overflow-hidden">
                  <div className="px-4 py-3 bg-raise">
                    <span className="block text-dim text-[0.65rem] uppercase tracking-[0.18em] font-semibold">
                      Drawn on
                    </span>
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-lg font-extrabold">{dayLabel(day)}</span>
                      <span className="tnum font-extrabold text-amber shrink-0">
                        {naira(items.reduce((t, r) => t + Number(r.amount || 0), 0))}
                      </span>
                    </span>
                  </div>
                  <ul>
                    {items.map(r => (
                      <li key={r.id} className="px-4 py-3 border-t border-line">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-semibold">{r.guest_name}</span>
                          <span className="tnum font-semibold shrink-0">{naira(r.amount)}</span>
                        </div>
                        {r.kind === 'meal' ? (
                          <p className="text-dim text-sm mt-0.5">
                            {r.room_number ? `Room ${r.room_number} · ` : ''}{r.description}
                          </p>
                        ) : (
                          <>
                            <p className="text-dim text-sm mt-0.5">
                              {r.room_number ? `Room ${r.room_number} · ` : ''}
                              {r.nights} {r.nights === 1 ? 'night' : 'nights'}
                              {r.check_in_date ? ` · ${shortDay(r.check_in_date)} to ${shortDay(r.actual_out)}` : ''}
                            </p>
                            <p className="text-dim text-sm">
                              Room {naira(r.room_charge)}
                              {r.overstay_charge > 0.009 ? ` · over-stay ${naira(r.overstay_charge)}` : ''}
                              {r.orders_charge > 0.009 ? ` · on the room bill ${naira(r.orders_charge)}` : ''}
                            </p>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )} />
          )}

          {paidIn.length > 0 && (
            <section className="mt-5 rounded-2xl border border-line bg-surface overflow-hidden">
              <div className="px-4 py-3 bg-raise">
                <span className="block text-dim text-[0.65rem] uppercase tracking-[0.18em] font-semibold">
                  Paid in
                </span>
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-lg font-extrabold">{paidIn.length} {paidIn.length === 1 ? 'payment' : 'payments'}</span>
                  <span className="tnum font-extrabold text-leaf shrink-0">{naira(totals.paid)}</span>
                </span>
              </div>
              <ul>
                {paidIn.map(p => (
                  <li key={p.id} className="px-4 py-3 border-t border-line">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold">{dayLabel(p.paid_on)}</span>
                      <span className="tnum font-semibold shrink-0 text-leaf">{naira(p.amount)}</span>
                    </div>
                    <p className="text-dim text-sm mt-0.5 capitalize">{p.method}</p>
                    {p.note && <p className="text-dim text-sm">{p.note}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {months.length > 1 && (
            <p className="text-dim text-sm mt-5 text-center">
              {months.length} months of drawings on this account.
            </p>
          )}
        </>
      )}
    </div>
  )
}
