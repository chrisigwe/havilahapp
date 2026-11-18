import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { lagosToday, methodLabel, naira, startingDept, stepMonth, tierLabel } from '../lib/format'
import { monthLabel } from '../lib/months'
import { splitRepaymentByCredit, applyMethods } from '../lib/creditsplit'
import RoomChargeTracker from '../components/RoomChargeTracker'
import { checkRepeatPayment, checkRepeatRepayment, deactivateCustomer, deleteCustomer, linkCustomerToGuest, loadBalances, loadCreditForMonth, loadCustomerLedger, loadCreditChain, loadFolio, loadStayMoves, loadGuestBalances, loadReservedValue, loadUnlinkedCustomerBalances, loadCustomerNeverAGuest, setCustomerNeverAGuest, moveWorkaroundToRoom, recordStayPayment, saveRepayment, searchSimilarGuests } from '../lib/data'
import { enqueue, flush, isConnectionError } from '../lib/outbox'
import PaymentMethodPicker, { paymentParts, paymentAllocated, paymentReady } from '../components/PaymentMethodPicker'
import { isClosedDayRefusal, submitPendingRepayment, loadPendingRepayments,
         approvePendingRepayment, rejectPendingRepayment,
         loadNoCreditIds, setCustomerNoCredit, loadLinkedGuestNames } from '../lib/data'
import FolioStatement from '../components/FolioStatement'
import { EDITOR, OPENS_ON_ALL, OVERSIGHT, SUPERVISOR, is } from '../lib/roles'
import { accountStatementPdf, savePdf } from '../lib/pdfSheet'
import Notice from '../components/Notice'
import { tracked } from '../lib/loadfail'
import { useScrollLock } from '../lib/scrollLock'



export default function Credit({ boot }) {
  const { staff, items, allLocations, locations } = boot
  const isEditor = is(staff.role, EDITOR)
  const isAdmin = is(staff.role, SUPERVISOR)
  // Collecting a debt that belongs to a COLLEAGUE is part of working a
  // bar: Prosper takes money for a customer Chidera gave credit to, and
  // the payment step asks whose debt it settles so the money is credited
  // to Chidera, not to whoever is holding the phone (27 October).
  //
  // On 6 November I narrowed this to GM and admin while removing the
  // three oversight roles' ability to collect at all. Only the second
  // was asked for. The first quietly took the Record payment button away
  // from every barman for every customer who was not their own, which is
  // what Prosper hit on 9 November. Restored: if you may collect, you may
  // collect for a colleague.
  //
  // The one person this used to exclude by staff id — the Awka store
  // manager — is a storekeeper, so NO_COLLECTING already stops her, and
  // migration 593 stops her in the database too.
  // Who may record money coming IN on this page — a debt repayment or
  // a guest's payment. Store manager, manager and auditor oversee the
  // money rather than handle it (Chris, 6 November 2026), so they read
  // this page and record nothing on it.
  //
  // Written as the three excluded roles rather than a list of allowed
  // ones: those are exactly the roles asked for, and a role not named
  // here keeps what it had rather than silently losing it.
  const NO_COLLECTING = ['storekeeper', 'manager', 'auditor']
  const canCollect = !NO_COLLECTING.includes(staff.role)
  // department chips must show EVERY department for management/audit
  // roles, explicitly — not by relying on boot.locations happening to
  // equal allLocations when nobody has assigned that person to a
  // single department. An auditor accidentally given a staff_locations
  // row would otherwise silently lose visibility with no error.
  const seesAllDepartments = is(staff.role, OVERSIGHT)  // same as Recovery and Sales
  const salesPoints = (seesAllDepartments ? allLocations : locations || [])
    .filter(l => l.is_sales_point && !l.is_store)
  // Whether this person can see guest-level, cross-department debt at
  // all — a role/assignment fact, not "which chip happens to be
  // selected right now". Guest balances (loadGuestBalances) already
  // aggregate every department for a linked guest; gating it on the
  // currently-selected chip instead of on actual Reception access
  // meant a front-desk person with Reception in their own location
  // list — Daniel, specifically — could still miss a guest's debt at
  // a department like MainBar just by having a different chip
  // selected when they looked.
  const hasReceptionAccess = seesAllDepartments || (locations || []).some(l => /reception/i.test(l.name))
  // 'all' = every department. Offered to whoever sees all departments;
  // auditors OPEN on it, since their job is the whole branch.
  const openingDept = () => is(staff.role, OPENS_ON_ALL) ? 'all' : startingDept(salesPoints, staff, locations)
  const [locId, setLocId] = useState(openingDept)
  // Re-sync the selected department when the GM switches branch — the
  // old branch's location id matches no chip here, so without this
  // nothing highlights until a manual tap.
  useEffect(() => {
    const valid = (locId === 'all' && seesAllDepartments) || salesPoints.some(l => l.id === locId)
    if (!valid) setLocId(openingDept())
  }, [staff.branch_id])
  const [confirmDel, setConfirmDel] = useState(null)
  const [delBusy, setDelBusy] = useState(false)
  // tracked synchronously so an in-flight response can check, when it
  // arrives, whether it's still answering the CURRENT question — a
  // ref rather than state, since it must be read inside an async
  // callback without being subject to closure staleness itself.
  // One department at a time is the only question this page asks now,
  // so the key is the department (Chris, 18 November 2026).
  const requestKey = `${locId}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const [rows, setRows] = useState(null)
  const [guestBalances, setGuestBalances] = useState(null)
  const [upcoming, setUpcoming] = useState([])
  const [guestPay, setGuestPay] = useState(null)   // { stayId, guestName, roomNumber, outstanding, billingCycle, amount, method, split, isOverstay }
  const [guestStatement, setGuestStatement] = useState(null)   // { room, folio, orderLines, payments } once loaded
  const [statementBusy, setStatementBusy] = useState(false)
  const toast = useToast()
  const [open, setOpen] = useState(null)       // { customer, ledger }
  // Whichever full-screen panel is up, the page behind it stops moving.
  useScrollLock(!!open)
  const [linking, setLinking] = useState(false)
  // Whether the open statement's account is marked as never a guest (579).
  const [openNotGuest, setOpenNotGuest] = useState(false)
  // The customer being linked. Previously the link sheet read
  // open.customer directly, so it could only be reached from inside
  // a statement — unreachable from Reception, which has no customer
  // list at all.
  const [linkTarget, setLinkTarget] = useState(null)
  const [unlinked, setUnlinked] = useState(null)
  // A whole month, for the credit analysis that sets payroll
  // deductions.
  //
  // The day view that used to sit beside this is gone (Chris, 18
  // November 2026). Three views competed to be the front of the page —
  // who owes, what happened on a day, what each owed at month end —
  // and the day one was the weakest of the three: everything it showed
  // is on Daily Sales already. Its date picker, and the arrows that
  // walked it, went with it.
  const [monthFilter, setMonthFilter] = useState(null)   // 'YYYY-MM'
  const [monthRows, setMonthRows] = useState(null)
  // A load that FAILED is not a month with nothing in it. The catch here
  // used to set an empty array, so a permissions error, a dropped
  // connection or a bad argument all came out as "No credit activity
  // that month" — stated as confidently as the truth. Stock.jsx already
  // learned this on 19 October: an empty list left behind by a failure
  // reads as a claim, not an absence.
  const [monthErr, setMonthErr] = useState(null)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState([])
  const [linkBusy, setLinkBusy] = useState(false)
  const [movingToRoom, setMovingToRoom] = useState(null)   // { customerId, locationId, amount }
  const [moveBusy, setMoveBusy] = useState(false)
  const [pay, setPay] = useState(null)
  // What a payment just cleared, shown once, right after it is saved.
  const [receipt, setReceipt] = useState(null)
  // The customer whose debt is split between two staff, while we ask
  // which of them the money settles.
  const [payWho, setPayWho] = useState(null)
  // A payment of the same amount, for the same customer, in the last
  // three days — shown for confirmation before this one is saved.
  const [repeat, setRepeat] = useState(null)
  const [busy, setBusy] = useState(false)
  // Shape only — neither touches what is loaded, so neither can change
  // a figure. Search filters the rows already in hand; sort reorders them.
  const [find, setFind] = useState('')
  // Which folded months are open. Absent means "use the default", which is
  // the month being worked; an entry means the person has decided.
  const [openMonths, setOpenMonths] = useState({})
  // A payment the till refused because its day is closed. Held here until
  // the person says whether to send it to the GM, rather than lost to a
  // toast they may not read.
  const [held, setHeld] = useState(null)
  const [pending, setPending] = useState([])
  const [deciding, setDeciding] = useState(null)   // { row, reason }
  const isBoss = ['gm', 'admin'].includes(staff.role)
  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items])
  const locById = useMemo(() => Object.fromEntries((allLocations || []).map(l => [l.id, l])), [allLocations])
  const isReception = /reception/i.test(locById[locId]?.name || '')

  useEffect(() => {
    if (!isBoss) return
    loadPendingRepayments(staff.branch_id, staff.id).then(setPending).catch(() => {})
  }, [isBoss, staff.branch_id, staff.id])

  // Who the GM has put on no credit. Shown beside the name here, and on
  // the briefing the bar reads each morning. It is a decision about a
  // person, which the branch's ₦50,000 cannot express: a figure cannot
  // say Chike gets nothing more while leaving a good customer his
  // ₦40,000.
  // WHAT IS STILL OWED, BY THE MONTH IT WAS RUN UP (Chris, 17 November
  // 2026: "Should be Month by Month starting from September").
  //
  // Because an untargeted repayment clears the OLDEST debt first, what
  // somebody still owes is their most recent credit. Ella's ₦16,800 is
  // ₦8,000 run up in October and ₦8,800 in November, and she belongs in
  // both months rather than only under whichever one she last bought in.
  //
  // credit_chain is the source because it already decides this, honours
  // settles_sale_id, and is what the statement and the day view read.
  // Three answers to "how much of this sale is still owed" would be
  // worse than no split at all. The whole history, never a window: a
  // window makes the oldest debt invisible and the ladder then credits
  // a repayment to the wrong sale.
  const [chain, setChain] = useState(null)
  useEffect(() => {
    loadCreditChain(staff.branch_id, null, 3650)
      .then(setChain).catch(() => setChain([]))
  }, [staff.branch_id])

  // The guest an account was pointed at, where that is a different name
  // from the account's own. Linking a credit account to a guest routes
  // the money onto their folio and renames nothing, so an account
  // somebody opened as "Main bar" or "Suite" keeps that name on a list
  // whose whole job is telling you who to ask. "Suite" is Sir Ben
  // Etiaba owing ₦46,000 (Chris, 17 November 2026).
  const [linkedGuest, setLinkedGuest] = useState({})
  useEffect(() => {
    loadLinkedGuestNames(staff.branch_id).then(setLinkedGuest).catch(() => {})
  }, [staff.branch_id])

  const [noCredit, setNoCredit] = useState(() => new Set())
  useEffect(() => {
    loadNoCreditIds(staff.branch_id).then(ids => setNoCredit(new Set(ids))).catch(() => {})
  }, [staff.branch_id])

  const refresh = useCallback(() => {
    const requestedFor = requestKey   // snapshot at the moment this fetch was started
    loadBalances(staff.branch_id, locId === 'all' ? null : locId, null)
      .then(data => { if (requestKeyRef.current === requestedFor) setRows(data) })
      .catch(e => toast(e.message, 'error'))
  }, [staff.branch_id, locId, requestKey])
  useEffect(refresh, [refresh])

  // Reception's guest balances — a different data model entirely, so
  // a separate load rather than folded into the customer refresh above.
  const refreshGuestBalances = useCallback(() => {
    if (!hasReceptionAccess) return
    tracked('What guests owe', loadGuestBalances(staff.branch_id, null))
      .then(setGuestBalances).catch(() => setGuestBalances([]))
    tracked('Bookings not yet arrived', loadReservedValue(staff.branch_id)).then(setUpcoming).catch(() => setUpcoming([]))
  }, [staff.branch_id, hasReceptionAccess])
  useEffect(refreshGuestBalances, [refreshGuestBalances])

  // Opens FIRST, then fills (25 October 2026). It used to await the
  // whole ledger before putting anything on screen, and that query has
  // no limit — a staff account with a year of credit pulls every sale
  // they have ever had. On a slow connection the tap simply did
  // nothing, which reads as the app freezing. Now the statement opens
  // immediately and says it is loading.
  async function openCustomer(c) {
    setOpen({ customer: c, ledger: null, chain: null, error: null })
    setOpenNotGuest(false)
    loadCustomerNeverAGuest(c.customer_id).then(setOpenNotGuest).catch(() => setOpenNotGuest(false))
    try {
      // Everything they owe at this branch, not the row you clicked
      // (Chris, 25 October 2026). The LIST is one row per customer per
      // department per staff member, so a person owing at MainBar and at
      // the Restaurant appears twice — and the statement used to be
      // filtered to the same slice. Handed to a customer, that
      // understates the debt. A statement is the whole account.
      //
      // Safe to total from the lines: v_customer_balances_by_staff counts
      // exactly what this query counts — credit sale payments and
      // repayments, with no exclusions on either side — so the totals
      // below agree with the balances on the list behind this panel.
      // Two loads, two jobs. The chain says what is STILL OWED, item by
      // item; the ledger supplies the payments received. 4000 days, not
      // the default 120: the oldest credit on the books is 20 May 2026,
      // and a debt that falls outside the window would simply vanish
      // from a statement whose whole purpose is to show what is unpaid.
      const [ledger, chain] = await Promise.all([
        loadCustomerLedger(staff.branch_id, c.customer_id, null, null),
        loadCreditChain(staff.branch_id, c.customer_id, 4000),
      ])
      setOpen(o => (o && o.customer.customer_id === c.customer_id) ? { ...o, ledger, chain } : o)
    } catch (e) {
      setOpen(o => (o && o.customer.customer_id === c.customer_id)
        ? { ...o, error: e.message || 'could not load' } : o)
    }
  }

  // What is still owed, item by item (Chris, 25 October 2026 — "the
  // statement should have unsettled debt").
  //
  // A statement used to list everything ever taken and everything ever
  // paid. For a regular customer that is pages of settled business with
  // the one figure that matters buried at the end. What a person should
  // be handed is what they still owe.
  //
  // credit_chain does this calculation already, and it is the same one
  // behind the panel lower down this page — so the two agree by
  // construction rather than being two sums of the same thing. It
  // applies money to the oldest item first, which is how it is settled
  // at the till anyway (570).
  //
  // Safe to total from these lines: the chain leaves out staff meals and
  // PR damage, and there are none on any customer account, so its total
  // equals the balance on the list behind this panel.
  const stmt = useMemo(() => {
    const chain = open?.chain || []
    const owing = chain.filter(r => Number(r.still_owed || 0) > 0.009)
    const totalOwed = owing.reduce((t, r) => t + Number(r.still_owed || 0), 0)
    const pays = open?.ledger?.repayments || []
    const paidTotal = pays.reduce((t, r) => t + Number(r.amount || 0), 0)
    const by = new Map()
    for (const r of owing) {
      const k = r.dept || 'none'
      if (!by.has(k)) by.set(k, { key: k, name: r.dept || 'Elsewhere', rows: [], subtotal: 0 })
      const g = by.get(k)
      g.rows.push(r); g.subtotal += Number(r.still_owed || 0)
    }
    const groups = [...by.values()].sort((a, b) => b.subtotal - a.subtotal)
    // The most recent payments only. The point of showing any is that a
    // customer sees their money acknowledged, not that they re-read a
    // year of history.
    const recent = pays.slice(0, 10)
    return { owing, totalOwed, paidTotal, groups, recent, morePays: Math.max(0, pays.length - recent.length) }
  }, [open?.chain, open?.ledger])

  useEffect(() => {
    if (!linking) return
    const t = setTimeout(() => {
      searchSimilarGuests(staff.branch_id, linkQuery).then(setLinkResults)
    }, 350)
    return () => clearTimeout(t)
  }, [linkQuery, linking, staff.branch_id])

  const refreshUnlinked = useCallback(() => {
    if (!hasReceptionAccess) return
    tracked('Customer accounts not linked to a guest',
            loadUnlinkedCustomerBalances(staff.branch_id, locId === 'all' ? null : locId,
                                         null))
      .then(setUnlinked).catch(() => setUnlinked([]))
  }, [hasReceptionAccess, staff.branch_id, locId])
  useEffect(refreshUnlinked, [refreshUnlinked])

  useEffect(() => {
    if (!monthFilter) { setMonthRows(null); return }
    const [y, m] = monthFilter.split('-').map(Number)
    setMonthRows(null)
    setMonthErr(null)
    tracked('Credit for the month',
            loadCreditForMonth(staff.branch_id, y, m, locId, null))
      .then(rows => { setMonthRows(rows); setMonthErr(null) })
      .catch(e => { setMonthErr(e?.message || 'could not load'); setMonthRows([]) })
  }, [monthFilter, locId, staff.branch_id])

  async function confirmLink(guest) {
    setLinkBusy(true)
    try {
      await linkCustomerToGuest(linkTarget.customerId, guest.id)
      toast(`Linked to ${guest.full_name}`, 'success')
      setLinking(false); setLinkTarget(null); setLinkQuery(''); setLinkResults([])
      refreshUnlinked()
    } catch (e) { toast(e.message, 'error') }
    setLinkBusy(false)
  }

  async function confirmMoveToRoom() {
    setMoveBusy(true)
    try {
      await moveWorkaroundToRoom(movingToRoom.customerId, movingToRoom.locationId)
      toast('Moved to room charge', 'success')
      setMovingToRoom(null); setOpen(null); refresh()
    } catch (e) { toast(e.message, 'error') }
    setMoveBusy(false)
  }

  // confirmed: the person has seen the "this may already be paid" warning
  // and said it is a separate payment. Passed as an argument rather than
  // parked in state — a state update does not resume the function that
  // was interrupted, so the confirmation has to travel with the retry.
  async function submitPayment(confirmed = false) {
    // The buttons are hidden for these roles, but a hidden button is not
    // a control. Anything that reaches here without the right role stops.
    if (!canCollect) { toast('Recording payments is not part of your role.', 'error'); return }
    if (!confirmed) {
      const prior = await checkRepeatRepayment(staff.branch_id, pay.customerId,
        paymentAllocated(pay, pay.amount))
      if (prior) { setRepeat(prior); return }
    }
    setBusy(true)
    const base = {
      staffLite: { id: staff.id, branch_id: staff.branch_id },
      customerId: pay.customerId, paidOn: pay.paidOn, note: pay.note,
      locationId: pay.locationId, creditStaffId: pay.creditStaffId,
    }
    // Split: no schema change needed — credit_repayments is already
    // one row per method, same as it's always been for a single
    // payment. "Split" just means saving more than one row for the
    // same repayment, one per method with a non-zero amount.
    // Clearing particular debts is one row per credit, each carrying the
    // sale it settles and the staff member who gave it (Chris, 13
    // November 2026). Picking a THING rather than a person is why this is
    // safe for bar staff: the line already knows who served it, so the
    // money cannot land on somebody who gave no credit.
    //
    // One method when targeting. Splitting by method AND by debt at once
    // would be a matrix nobody could check at a bar at night.
    const parts = pay.targets
      ? (() => {
          // A TARGETED PAYMENT NAMES ITS DEBTS AND MAY STILL BE SPLIT
          // (Chris, 18 November 2026 — fundamental 4: "debt that wasn't
          // repaid stays in that month").
          //
          // The chain row behind each chosen sale carries the department
          // and the person who gave it, so each written row goes to the
          // counter the debt is at rather than to the sheet's one
          // department. The month list and the statement both feed this,
          // so the lookup tries whichever chain is loaded.
          //
          // applyMethods walks the debts against the method parts, which
          // is what lets "part cash, part POS" settle named debts: one
          // row per debt per method, each still naming its sale. That
          // used to be forbidden — "one method only" — because there was
          // no rule for it.
          const src = (open?.chain?.length ? open.chain : chain) || []
          const debts = Object.entries(pay.targets)
            .map(([saleId, amt]) => {
              const row = src.find(c => c.sale_id === saleId)
              return { saleId, amount: Number(amt || 0),
                       staffId: row?.staff_id || null,
                       locationId: row?.location_id || null,
                       on: row?.taken_on || '' }
            })
            .filter(d => d.amount > 0.009)
            .sort((a, b) => String(a.on).localeCompare(String(b.on)))
          const methods = paymentParts(pay, pay.amount).filter(m => m.amount > 0)
          return applyMethods(debts, methods).map(x => ({
            method: x.method, amount: x.amount, settlesSaleId: x.saleId,
            creditStaffId: x.staffId, locationId: x.locationId,
          }))
        })()
      : pay.spread
        ? applyMethods(
            splitRepaymentByCredit(pay.spread, pay.amount, staff.id),
            paymentParts(pay, pay.amount).filter(p => p.amount > 0))
          .map(p => ({ method: p.method, amount: p.amount,
                       locationId: p.locationId, creditStaffId: p.staffId }))
        : paymentParts(pay, pay.amount).filter(p => p.amount > 0)
    try {
      for (const part of parts) {
        // Made before the first attempt and carried into the outbox, so a
        // retry of a payment that already landed writes nothing (621).
        const args = { ...base, amount: part.amount, method: part.method,
                       clientRef: crypto.randomUUID(),
                       settlesSaleId: part.settlesSaleId || null,
                       // A spread row names its own department as well as
                       // its own person: the same person can be owed at
                       // two counters, and the repayment belongs to the
                       // counter the debt is at.
                       locationId: part.locationId || base.locationId,
                       creditStaffId: part.creditStaffId || base.creditStaffId }
        try {
          await saveRepayment({ ...args, staff })
        } catch (e) {
          if (!isConnectionError(e)) throw e
          enqueue({ kind: 'repayment', payload: args })
        }
      }
      flush()
      // A RECEIPT, WHERE THE PAYMENT NAMED ITS DEBTS (Chris, 18 November
      // 2026, on the prototype). A toast saying "Payment recorded" is
      // true and tells the collector nothing: which debts went, in which
      // months, by which method. This says it, once, and closes the
      // account behind it so the next open reloads fresh.
      if (pay.targets) {
        const src = (open?.chain?.length ? open.chain : chain) || []
        const byMethod = {}
        for (const q of parts) byMethod[q.method] = (byMethod[q.method] || 0) + Number(q.amount || 0)
        setReceipt({
          name: open?.customer?.name || 'this account',
          amount: parts.reduce((t, q) => t + Number(q.amount || 0), 0),
          methods: Object.entries(byMethod).map(([method, amount]) => ({ method, amount })),
          cleared: parts.map(q => {
            const row = src.find(c2 => c2.sale_id === q.settlesSaleId)
            return {
              item: row?.item || 'Item', on: row?.taken_on || '',
              dept: row?.dept || '', month: String(row?.taken_on || '').slice(0, 7),
              amount: Number(q.amount || 0),
            }
          }),
        })
      } else {
        toast('Payment recorded', 'success')
      }
      setPay(null); setOpen(null); refresh()
    } catch (e) {
      // Every other refusal is final and must be read. This one has a
      // route: the GM can let it in, and nothing else can.
      if (isClosedDayRefusal(e)) setHeld({ base, parts, message: e.message })
      else toast('Not saved: ' + e.message, 'error')
    }
    setBusy(false)
  }

  async function sendToGM() {
    if (!held) return
    setBusy(true)
    try {
      for (const part of held.parts) {
        await submitPendingRepayment({
          ...held.base, staff, amount: part.amount, method: part.method,
          paidOn: held.base.paidOn, clientRef: crypto.randomUUID(),
          reason: held.message,
        })
      }
      toast('Sent to the GM', 'success')
      setHeld(null); setPay(null); setOpen(null); refresh()
    } catch (e) { toast('Not sent: ' + e.message, 'error') }
    setBusy(false)
  }

  async function decide(approve) {
    const d = deciding
    if (!d) return
    setBusy(true)
    try {
      if (approve) await approvePendingRepayment(d.row.id, staff.id, d.reason || null)
      else await rejectPendingRepayment(d.row.id, staff.id, d.reason)
      toast(approve ? 'Approved' : 'Rejected', 'success')
      setDeciding(null)
      loadPendingRepayments(staff.branch_id, staff.id).then(setPending).catch(() => {})
      refresh()
    } catch (e) { toast(e.message, 'error') }
    setBusy(false)
  }

  async function submitGuestPayment() {
    if (!canCollect) { toast('Recording payments is not part of your role.', 'error'); return }
    // Same guard as the folio: a payment the attendant could not see land
    // gets entered a second time, and the screen is the one thing that
    // cannot tell them so.
    const parts = paymentParts(guestPay, guestPay.amount)
    const total = parts.reduce((s, p) => s + Number(p.amount || 0), 0)
    const repeat = await checkRepeatPayment(guestPay.stayId, total)
    if (repeat && !window.confirm(
          `${naira(repeat.amount)} was already recorded on this bill `
          + `${repeat.minutesAgo} minute${repeat.minutesAgo > 1 ? 's' : ''} ago`
          + `${repeat.who ? ` by ${repeat.who}` : ''}.\n\n`
          + `Is this a second ${naira(total)} the guest has just paid?\n\n`
          + 'Tap Cancel if it is the same money — it is already saved.')) {
      return
    }
    setBusy(true)
    try {
      await recordStayPayment({
        staff, stayId: guestPay.stayId, businessDate: lagosToday(),
        cycle: guestPay.billingCycle, parts: paymentParts(guestPay, guestPay.amount),
        isOverstay: guestPay.isOverstay,
      })
      toast('Payment recorded', 'success')
      setGuestPay(null); refreshGuestBalances()
    } catch (e) { toast('Not saved: ' + e.message, 'error') }
    setBusy(false)
  }

  // guestPay only carries what the payment form needs (outstanding,
  // billing cycle) — the full charge/payment breakdown a printed
  // statement needs lives in loadFolio, the same function Folio.jsx
  // already uses, so this fetches it fresh rather than duplicate
  // that query's shape here.
  async function printGuestStatement() {
    setStatementBusy(true)
    try {
      // moves alongside the folio (576): the folio's total now carries any
      // room change, so a statement printed without the move line would
      // show a total that does not add up from the lines above it. The
      // same fault the credit statements had on 25 October.
      const [{ orders, payments, folio, departmentCredit, billedToYou }, moves] = await Promise.all([
        loadFolio(guestPay.stayId),
        loadStayMoves(guestPay.stayId).catch(() => []),
      ])
      const orderLines = orders.flatMap(o => (o.order_items || []).map(li => ({ ...li, date: o.business_date })))
      setGuestStatement({
        room: { room_number: guestPay.roomNumber, guest_name: guestPay.guestName,
                check_in_date: folio?.check_in_date, scheduled_out: folio?.scheduled_out },
        folio, orderLines, payments, moves, departmentCredit, billedToYou,
      })
    } catch (e) { toast('Could not load statement: ' + e.message, 'error') }
    setStatementBusy(false)
  }

  if (!rows) return <p className="px-5 text-dim">Loading…</p>
  // Final safety net against any stale-response race: never show a row
  // whose location doesn't match the selected department, and (when a
  // staff filter is active) whose booker doesn't match it either. Even
  // if a late/out-of-order fetch lands in `rows`, it physically cannot
  // paint under the wrong department — the filter is on the data
  // itself, not on a timing guard that can drift.
  const inScope = rows.filter(r =>
    (!locId || locId === 'all' || r.location_id === locId))
  // One line per person, always (Chris, 27 October 2026: "why is the
  // Credit page duplicating customer records?").
  //
  // It was not duplicating anything. The view behind this list is one row
  // per customer PER DEPARTMENT PER STAFF MEMBER, and only the all-
  // departments view combined them — so inside a single department, a
  // customer two different people had given credit to appeared twice.
  // Measured on 27 October: 54 rows for 31 actual people, and not one
  // duplicated customer record in the database.
  //
  // The split is not noise: credit stays with whoever gave it, and a
  // repayment is credited back to that person. So the slices are KEPT,
  // on `parts`, and the payment step asks which one it settles when
  // there is more than one. Combining without that would have credited
  // the money to whoever happened to be recording it.
  //
  // Combined BEFORE the owing filter, so an overpayment at one counter
  // correctly reduces what the person owes overall.
  const combined = Object.values(inScope.reduce((acc, r) => {
    const a = acc[r.customer_id] || (acc[r.customer_id] = {
      ...r, credit_taken: 0, repaid: 0, balance: 0,
      location_id: null, staff_id: null, staff_name: null, deptIds: [], parts: [] })
    a.credit_taken += Number(r.credit_taken); a.repaid += Number(r.repaid); a.balance += Number(r.balance)
    if (r.first_credit_date && (!a.first_credit_date || r.first_credit_date < a.first_credit_date)) a.first_credit_date = r.first_credit_date
    if (r.last_credit_date && (!a.last_credit_date || r.last_credit_date > a.last_credit_date)) a.last_credit_date = r.last_credit_date
    if (Number(r.balance) > 0.009 && !a.deptIds.includes(r.location_id)) a.deptIds.push(r.location_id)
    if (Number(r.balance) > 0.009) {
      a.parts.push({ location_id: r.location_id, staff_id: r.staff_id,
                     staff_name: r.staff_name, balance: Number(r.balance),
                     first_credit_date: r.first_credit_date,
                     last_credit_date: r.last_credit_date })
    }
    return acc
  }, {})).map(a => {
    // A single slice keeps its own department and staff, so everything
    // downstream — the payment button, the on-behalf rule — behaves
    // exactly as it did before for the ordinary case.
    if (a.parts.length === 1) {
      return { ...a, location_id: a.parts[0].location_id,
               staff_id: a.parts[0].staff_id, staff_name: a.parts[0].staff_name }
    }
    // Oldest first: the order money is applied in everywhere else.
    return { ...a, parts: [...a.parts].sort((x, y) =>
      String(x.last_credit_date || '').localeCompare(String(y.last_credit_date || ''))) }
  }).sort((x, y) => String(y.last_credit_date || '').localeCompare(String(x.last_credit_date || '')))
  const owing = combined.filter(r => Number(r.balance) > 0.009)
  const total = owing.reduce((s, r) => s + Number(r.balance), 0)

  // Finding one person in a list of debtors was done by scrolling.
  // Filtering on what is already loaded — no query, no spinner.
  const needle = find.trim().toLowerCase()
  const matched = needle
    ? owing.filter(c => (c.name || '').toLowerCase().includes(needle))
    : owing
  // Oldest owing first, always (Chris, 13 November 2026). Recent /
  // Biggest / Oldest was three choices where one judgement belongs: the
  // debt that has been outstanding longest is the one to act on, and
  // the months above it already separate the active from the dormant.
  // A tie goes to the larger balance.
  const shown = [...matched].sort((a, b) =>
    String(a.first_credit_date || '9999-12-31').localeCompare(String(b.first_credit_date || '9999-12-31'))
    || Number(b.balance) - Number(a.balance))

  // Days between a business date and today, counted in Lagos dates
  // rather than in milliseconds from the device clock.
  const daysSince = (d) => {
    if (!d) return null
    const a = new Date(d + 'T12:00:00'), b = new Date(lagosToday() + 'T12:00:00')
    return Math.round((b - a) / 86400000)
  }
  const oldest = owing.reduce((o, r) =>
    r.first_credit_date && (!o || r.first_credit_date < o) ? r.first_credit_date : o, null)
  const biggest = owing.reduce((m, r) => Math.max(m, Number(r.balance)), 0)
  // How much of the total has been owed for more than a month (Chris,
  // 13 November 2026). "Oldest since 7 Sep" names a date and says
  // nothing about how much is sitting behind it — on 12 November that
  // date hid ₦413,950 of ₦441,050, which is the fact worth acting on.
  // Counted from when each debt STARTED, so a regular who has owed
  // something since September counts even though they bought today.
  const monthAgo = (() => {
    const d = new Date(lagosToday() + 'T12:00:00')
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })()
  const overAMonth = owing.reduce((t, r) =>
    r.first_credit_date && r.first_credit_date <= monthAgo ? t + Number(r.balance) : t, 0)
  const takenAllTime = owing.reduce((t, r) => t + Number(r.credit_taken || 0), 0)
  const repaidAllTime = owing.reduce((t, r) => t + Number(r.repaid || 0), 0)

  // fromMonth: this row is one month's share of what somebody owes, not
  // their whole account. The lifetime "taken · repaid" line is then a
  // different scale from the figure on the right and only misleads, so
  // it is replaced by what the figure actually is.
  // The linked guest's name, but only when it is genuinely a different
  // name. Most links point an account at the guest it was already named
  // after — "Sir Ben Etiaba" at Sir Ben Etiaba — and printing both
  // there would be noise. Compared on letters and digits alone, so
  // "Mr Michael (Room 206)" and "Mr Michael Ike" still count as
  // different while spacing and punctuation do not.
  const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const guestNameFor = (c) => {
    const g = linkedGuest[c?.customer_id]
    if (!g) return null
    return plain(g) === plain(c?.name) ? null : g
  }

  // Collecting straight off the list (Chris, 17 November 2026: "Can I be
  // able to take payments from the main list?").
  //
  // The same two steps the statement takes, so there is one way to
  // record a repayment and not two. Where more than one person gave the
  // credit it asks whose debt the money settles rather than crediting
  // whoever is holding the phone.
  //
  // THE MONTH YOU TAPPED IS WHAT IT OFFERS (Chris, 17 November 2026:
  // "When debt is taken from September, October debt should still be
  // there, likewise November").
  //
  // Collect first suggested the person's WHOLE balance, so tapping it on
  // a September row offered Ella's entire ₦16,800 and taking that would
  // have cleared October and November with it. The suggested amount is
  // now that month's share; the ceiling stays the full balance, so
  // collecting more than one month is still possible, just never the
  // accident.
  //
  // It lands where it should without anything further: an untargeted
  // repayment clears the OLDEST debt first, so September's figure pays
  // off exactly September's sales and leaves the later months standing.
  // Which department a repayment from this row gets credited to, or null
  // when it cannot be told (Chris, 17 November 2026: "GM/Admin and
  // Auditors have view access to All Departments").
  //
  // Collecting used to be hidden outright while "All departments" was
  // chosen — which hid it from exactly the people who chase debts, since
  // that is the view they open on. But the old comment says what the
  // rule was really for: "in the all view it would otherwise fall back
  // to the literal 'all'". It guarded a bad fallback, it was never a
  // policy. A customer with credit at one department carries that
  // department on the row even in the all view, and one with credit at
  // several carries parts the chooser settles. So the fallback is fixed
  // instead, and never reaches for locId unless locId is a real place.
  const payLocationFor = (c) => c?.location_id || (locId !== 'all' ? locId : null)
  const canTakeFrom = (c) => canCollect && Number(c?.balance) > 0.009
    && ((c?.parts || []).length > 1 || !!payLocationFor(c))

  // The unpaid debts of ONE month, oldest first, up to what is being
  // paid. This is fundamental 4 made mechanical: a payment taken against
  // September names September's sales, so it cannot reach into October
  // however the ladder would otherwise have applied it.
  const targetsForMonth = (customerId, monthKey, amount) => {
    const rows = (chain || [])
      .filter(r => r.customer_id === customerId
        && String(r.taken_on || '').slice(0, 7) === monthKey
        && Number(r.still_owed) > 0.009)
      .sort((a, b) => String(a.taken_on).localeCompare(String(b.taken_on)))
    const out = {}
    let left = Number(amount) || 0
    for (const r of rows) {
      if (left <= 0.009) break
      const take = Math.min(left, Number(r.still_owed))
      out[r.sale_id] = String(Math.round(take * 100) / 100)
      left = Math.round((left - take) * 100) / 100
    }
    return out
  }

  // THE ACCOUNT'S OWN COLLECT ROUTES (Chris, 18 November 2026, on the
  // prototype). The main list collects a month across people; these two
  // collect inside one person's account, which is where a guest clearing
  // their debt is actually dealt with.
  //
  // Both go through `targets`, so each written row names the sale it
  // settles and carries that sale's own department and collector. A
  // month here can never reach into another month.
  const targetsFrom = (rows) => {
    const out = {}
    for (const r of [...rows].sort((a, b) =>
      String(a.taken_on).localeCompare(String(b.taken_on)))) {
      out[r.sale_id] = String(Math.round(Number(r.still_owed) * 100) / 100)
    }
    return out
  }
  const openPayFor = (rows, fromMonth) => {
    const c = open?.customer
    const unpaid = (rows || []).filter(r => Number(r.still_owed) > 0.009)
    if (!c || !unpaid.length) return
    const amount = Math.round(unpaid.reduce((t, r) => t + Number(r.still_owed), 0) * 100) / 100
    setPay({
      customerId: c.customer_id, amount, method: null,
      paidOn: lagosToday(), note: '', balance: Number(c.balance),
      locationId: payLocationFor(c), creditStaffId: c.staff_id || staff.id,
      targets: targetsFrom(unpaid), fromMonth: fromMonth || null,
    })
  }

  // THE STATEMENT AS TEXT (Chris, 18 November 2026: "the statement can
  // be shared via WhatsApp, etc").
  //
  // The PDF already reaches WhatsApp through the phone's share sheet,
  // and it is the right thing when a guest wants a document. It is the
  // wrong thing for chasing N7,100 on a small phone: it arrives as a
  // file somebody has to open. Text arrives readable, and both sides can
  // quote the same lines back when a figure is queried.
  //
  // Settled months are left out entirely. The message shows what is
  // being chased, not the history.
  const statementText = () => {
    const c = open?.customer
    const rows = (open?.chain || []).filter(r => Number(r.still_owed) > 0.009)
    const day = d => new Date(String(d) + 'T12:00:00')
      .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
    const by = {}
    for (const r of rows) {
      const k = String(r.taken_on || '').slice(0, 7)
      ;(by[k] || (by[k] = [])).push(r)
    }
    const out = []
    out.push(String(boot.branchName || 'Havilah Suite').toUpperCase())
    out.push(c?.name || '')
    out.push('Account as at ' + new Date()
      .toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }))
    const keys = Object.keys(by).sort()
    if (keys.length) {
      out.push('', 'STILL UNPAID')
      for (const k of keys) {
        const owed = by[k].reduce((t, r) => t + Number(r.still_owed), 0)
        out.push(`${monthLabel(k)} — ${naira(owed)}`)
        for (const r of by[k]) {
          out.push(`  ${day(r.taken_on)} · ${r.item}${r.qty ? ` ×${r.qty}` : ''}`
            + ` — ${naira(r.still_owed)}`
            + (Number(r.recovered) > 0.009 ? ` (${naira(r.recovered)} already paid)` : ''))
        }
      }
    }
    const total = rows.reduce((t, r) => t + Number(r.still_owed), 0)
    out.push('', 'TOTAL OWING: ' + (total > 0.009 ? naira(total) : 'nothing — settled'))
    return out.join('\n')
  }

  // The phone's own share sheet first, which is what puts WhatsApp in
  // front of the collector. The clipboard is the fallback for a laptop.
  async function sendStatement() {
    const text = statementText()
    try {
      if (navigator.share) {
        await navigator.share({ text, title: `Statement — ${open?.customer?.name || ''}` })
        return
      }
    } catch (e) {
      if (e?.name === 'AbortError') return      // they closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(text)
      toast('Statement copied — paste it into the chat', 'success')
    } catch {
      toast('This device would not share or copy the statement', 'error')
    }
  }

  const collectFrom = (row, fromMonth) => {
    const c = row.__whole || row
    const suggested = Number(row.__whole ? row.balance : c.balance)
    // Collecting from a month heading settles that month's own debts.
    // It takes precedence over the spread below, and names the
    // department and the person for each debt on the way through, so a
    // month spanning two counters still pays each counter its own.
    if (fromMonth) {
      const targets = targetsForMonth(c.customer_id, fromMonth, suggested)
      if (Object.keys(targets).length) {
        setPay({
          customerId: c.customer_id, amount: suggested, method: null,
          paidOn: lagosToday(), note: '', balance: Number(c.balance),
          locationId: payLocationFor(c), creditStaffId: c.staff_id || staff.id,
          targets, fromMonth,
        })
        return
      }
    }
    const where = payLocationFor(c)
    // TWO PEOPLE GAVE THIS CREDIT, AND THAT IS NOT THE COLLECTOR'S
    // PROBLEM (Chris, 18 November 2026: collecting is awkward).
    //
    // This used to open a chooser — "whose credit is being paid?" — and
    // take one answer, so a customer clearing what they owed at two
    // counters had to be entered twice. At Awka that is 36 people.
    //
    // The question already has an answer that does not need asking:
    // oldest debt first, which is the rule splitRepaymentByCredit has
    // applied at the front desk since 9 November and the rule the
    // statement chain uses everywhere else. So the payment is spread
    // down the debts in that order, and the sheet shows where each naira
    // lands before it is saved. The chooser is still there for a
    // customer who insists on clearing one person's debt only — it is
    // just no longer the way through.
    const slices = (c.parts || [])
    if (slices.length > 1) {
      setPay({
        customerId: c.customer_id, amount: suggested, method: null,
        paidOn: lagosToday(), note: '', balance: Number(c.balance),
        locationId: slices[0].location_id,
        creditStaffId: slices[0].staff_id || staff.id,
        spread: slices.map(p => ({
          staffId: p.staff_id, locationId: p.location_id,
          staffName: p.staff_name, balance: Number(p.balance),
          firstCreditDate: p.first_credit_date, lastCreditDate: p.last_credit_date,
        })),
        whole: c,
      })
      return
    }
    // No department on the row: ask rather than guess. Nothing is ever
    // recorded against the literal 'all'.
    if (!where) { setPayWho(c); return }
    setPay({
      customerId: c.customer_id, amount: suggested, method: null,
      paidOn: lagosToday(), note: '', balance: Number(c.balance),
      locationId: where,
      creditStaffId: c.staff_id || staff.id,
    })
  }

  const debtorRow = (c, fromMonth) => {
          const days = daysSince(c.last_credit_date)
          const canTake = canTakeFrom(c.__whole || c)
          return (
          <li key={fromMonth ? `${c.customer_id}:${fromMonth}` : c.customer_id}
            className="flex items-stretch gap-2 rounded-2xl border border-line
                       bg-surface px-4">
            {/* The whole row opens the statement. It always did, but
                nothing said so — no chevron, no label — so staff asked
                where a customer's history was. */}
            <button onClick={() => openCustomer(c)}
              className="flex-1 min-w-0 py-3 flex items-center gap-3 text-left">
              <div className="flex-1 min-w-0">
                {/* The person, then the account it was opened under —
                    only where they are different names, so an ordinary
                    row is unchanged. */}
                <div className="font-semibold break-words">
                  {guestNameFor(c) || c.name}
                </div>
                {guestNameFor(c) && (
                  <div className="text-dim text-xs break-words">
                    opened as “{c.name}”
                  </div>
                )}
                {noCredit.has(c.customer_id) && (
                  <div className="text-clay text-xs font-semibold">
                    No credit — cash or POS only
                  </div>
                )}
                <div className="text-dim text-sm">
                  {fromMonth
                    ? `still owing from ${monthLabel(fromMonth)}`
                    : `${naira(c.credit_taken)} taken · ${naira(c.repaid)} repaid`}
                </div>
                {!!c.deptIds?.length && (
                  <div className="text-dim text-xs">
                    {c.deptIds.map(id => locById[id]?.name).filter(Boolean).join(', ')}
                  </div>
                )}
                <div className="text-sm">
                  {/* Days, not just a date. "3 Oct" needs working out;
                      "15 days ago" is the thing being judged. Clay past
                      a month — a fact about when credit was last taken,
                      which is all this data says: nothing here records
                      a due date, so nothing here calls it overdue. */}
                  {days != null && (
                    <span className={days >= 30 ? 'text-clay' : 'text-dim'}>
                      last took credit {days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}
                    </span>
                  )}
                  {c.first_credit_date && c.first_credit_date !== c.last_credit_date && (
                    <span className="text-dim"> · since {new Date(c.first_credit_date + 'T12:00:00')
                      .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</span>
                  )}
                  {c.staff_name && <span className="text-dim"> · by {c.staff_name}</span>}
                  {/* Two people gave this person credit. One line, both
                      named — which is what the two rows were really
                      saying, without reading as the same customer twice. */}
                  {c.parts?.length > 1 && (
                    <span className="text-dim"> · by {c.parts.map(p2 => p2.staff_name || 'someone').join(' and ')}</span>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-right">
                {/* An account that owes nothing says which kind of
                    nothing. Paid ahead is not the same as square, and a
                    negative column is the shape that hid Mr Michael. */}
                <span className={`tnum font-bold block ${
                  Number(c.balance) > 0.009 ? 'text-clay' : 'text-leaf'}`}>
                  {Number(c.balance) > 0.009 ? naira(c.balance)
                    : Number(c.balance) < -0.009 ? `${naira(-c.balance)} ahead`
                    : 'square'}
                </span>
                <span className="text-dim text-xs">statement ›</span>
              </span>
            </button>
            {canTake && (
              <button type="button" onClick={() => collectFrom(c, fromMonth)}
                aria-label={`Collect from ${c.name}`}
                className="shrink-0 self-center px-3 h-11 rounded-xl border border-amber
                           text-amber text-sm font-bold">
                Collect
              </button>
            )}
          </li>
    )
  }

  return (
    <div className="px-5">
      {salesPoints.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2 -mx-1 px-1">
          {seesAllDepartments && (
            <button onClick={() => setLocId('all')}
              className={`shrink-0 h-11 px-4 rounded-full border ${locId === 'all'
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              All departments
            </button>
          )}
          {salesPoints.map(l => (
            <button key={l.id} onClick={() => setLocId(l.id)}
              className={`shrink-0 h-11 px-4 rounded-full border ${l.id === locId
                ? 'bg-amber text-bg border-amber font-bold' : 'border-line text-dim'}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}

      {/* One question: who is owing (Chris, 13 and 18 November 2026).

          The page IS the balances, folded by month. What used to sit
          above them — a date picker with its arrows, and a row of staff
          chips — is gone: the day it broke down is on Daily Sales, and
          who gave the credit is a line on each row rather than a way of
          slicing the list. The month-end view stays, because it is what
          sets a payroll deduction, but as a line you follow rather than
          a mode to rule out first. */}
      {monthFilter && (
        <button onClick={() => setMonthFilter(null)}
          className="h-10 px-4 mb-2 rounded-xl border border-line text-dim text-sm">
          ← Back to who is owing
        </button>
      )}

      {/* Not "for deductions" (Chris, 17 November 2026): deductions are
          for staff only, customers do not get them, and naming the whole
          view after one half's use of it is what made it confusing.
          Since 18 November there is no staff half at all — it lives in
          Payroll, where the employee link is real — so the door now says
          whose money it is. */}
      {!monthFilter && (
        <button onClick={() => setMonthFilter(lagosToday().slice(0, 7))}
          className="text-dim text-sm underline underline-offset-4 decoration-line pb-1 text-left">
          What each owed at the end of a month
        </button>
      )}

      {monthFilter && (
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <button type="button" aria-label="Previous month"
            onClick={() => setMonthFilter(m => stepMonth(m, -1, lagosToday().slice(0, 7)))}
            className="h-11 w-11 shrink-0 rounded-xl bg-surface border border-line
                       text-ink text-xl leading-none">‹</button>
          <input type="month" value={monthFilter} max={lagosToday().slice(0, 7)}
            onChange={e => { if (e.target.value) { setMonthFilter(e.target.value); setDayFilter('') } }}
            className="h-11 px-3 rounded-xl bg-surface border border-amber text-amber tnum" />
          <button type="button" aria-label="Next month"
            onClick={() => setMonthFilter(m => stepMonth(m, 1, lagosToday().slice(0, 7)))}
            disabled={monthFilter >= lagosToday().slice(0, 7)}
            className="h-11 w-11 shrink-0 rounded-xl bg-surface border border-line
                       text-ink text-xl leading-none disabled:opacity-40">›</button>
          <span className="text-dim text-sm">What each owed at the end of that month</span>
        </div>
      )}

      {monthFilter && (() => {
        if (monthRows === null) return <p className="text-dim py-8 text-center">Loading…</p>
        if (monthErr) {
          return (
            <p className="text-clay py-8 text-center">
              This month could not be loaded — which is not the same as there
              being nothing in it.
              <span className="block text-xs text-dim mt-1 break-words">{monthErr}</span>
            </p>
          )
        }
        if (!monthRows.length) {
          // Say what was ASKED FOR, not just that nothing came back. The
          // department chip filters this view as well as the day view,
          // so "no activity" on OpenBar is a different statement from
          // "no activity", and reading it as the second is how a month
          // with nineteen debtors in it looked empty.
          const whereName = locId === 'all'
            ? 'all departments' : (locById[locId]?.name || 'this department')
          return (
            <p className="text-dim py-8 text-center">
              No credit activity in {monthLabel(monthFilter)} at {whereName}.
              <span className="block text-xs mt-1">
                Credit at another department is not counted here.
              </span>
            </p>
          )
        }
        // CUSTOMERS ONLY (Chris, 18 November 2026).
        //
        // Staff used to have their own section here, as a deduction
        // sheet. It was a worse copy of one that already exists: Payroll
        // → Pull credit deductions takes each employee's unsettled
        // credit for a chosen month, plus the accounts they are
        // responsible for, honours the grace month (August's debt out of
        // October's salary), is reviewed line by line before finalising,
        // and on finalising writes the repayment — so the balance drops
        // and the person leaves the main list on their own.
        //
        // Above all it attributes by a REAL link: a payroll employee
        // carries customer_id. This section identified a person by the
        // word "staff" in a customer name, and of the 21 staff-named
        // accounts at Awka only 9 matched an employee by name, while
        // "Manager (staff)" and "Supervisor (staff)" are job titles with
        // no one behind them. "Manager (staff)" took N39,500 in
        // September. No sheet should propose taking that out of a salary
        // without knowing whose.
        //
        // What is left has no equivalent anywhere: Payroll only knows
        // employees, and Payroll is GM/admin, so a manager or auditor
        // cannot see any of this. Customers are chased, not deducted,
        // and this is the record they are chased from.
        const monthCustomers = monthRows.filter(r => !r.is_staff)
        const monthStaff = monthRows.filter(r => r.is_staff)
        const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0)

        const section = (title, rows, note) => !!rows.length && (
          <section className="mt-4">
            <div className="flex items-baseline justify-between pb-1 border-b border-line">
              <h2 className="font-semibold">{title}</h2>
              <span className="tnum font-bold text-clay">{naira(sum(rows, 'closing'))}</span>
            </div>
            {note && <p className="text-dim text-xs mt-1">{note}</p>}
            <div className="mt-2 space-y-2">
            {rows.map(r => {
              // Reaching the person from here (Chris, 12 November 2026).
              // The month view listed who owed what and stopped there, so
              // the only way to open a debtor was to go back to Balances
              // and find them again. The row now opens the same statement
              // the Balances list does — every department they owe at, who
              // gave each credit, and the payment step — rather than a
              // second, half-informed sheet of its own.
              const live = combined.find(c => c.customer_id === r.customer_id)
              // STILL OWING is a balance, not a membership (Chris, 17
              // November 2026: "Oga Emmy in Awka says 1000 owed in Sep
              // but when you want to collect the payment it says 0
              // owe").
              //
              // Both figures were right. September genuinely closed with
              // him owing ₦1,000 and he has paid since, so Collect
              // correctly offers nothing. The page is supposed to say
              // that — and did not, because `live` only asked whether he
              // appears in `combined`, which holds EVERY customer in
              // scope, settled ones included. For anyone who has ever
              // taken credit it is truthy, so the note never printed on
              // the people it was written for.
              const owesNow = Number(live?.balance ?? 0) > 0.009
              const closedOwing = Number(r.closing) > 0.009
              // Three states, not two (Chris, 18 November 2026).
              //
              // The colour was decided by the closing figure alone, so a
              // month that closed owing was painted clay whatever had
              // happened since. That put the colour of money to chase
              // directly beside a line reading "paid since — nothing
              // owing now", on the same row: Afunwa, Obinna White, the
              // General Manager, Sir chuka, Oga Emmy and the written-off
              // Minimart bucket all sat in red having paid in full.
              //
              // The figure itself stays — the month did close that way,
              // and that is what the deduction was taken on — but it is
              // dimmed out of the set that needs action, which is what
              // this view is read for.
              const tone = !closedOwing ? 'text-leaf' : owesNow ? 'text-clay' : 'text-dim'
              return (
                <button key={r.customer_id} type="button"
                  disabled={!live}
                  onClick={() => live && openCustomer(live)}
                  className="w-full text-left px-4 py-3 rounded-2xl border border-line
                             bg-surface disabled:opacity-60">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{r.name}</span>
                    <span className={`tnum font-bold shrink-0 ${tone}`}>
                      {closedOwing ? naira(r.closing) : 'settled'}
                    </span>
                  </div>
                  <div className="text-dim text-xs">
                    owed {naira(r.opening)} at the start
                    {' · '}took {naira(r.taken)}
                    {' · '}repaid {naira(r.repaid)}
                    {!owesNow && closedOwing
                      ? ' · paid since — nothing owing now' : ''}
                  </div>
                </button>
              )
            })}
            </div>
          </section>
        )

        return (
          <>
            <div className="rounded-2xl border border-amber bg-surface p-4 my-2">
              <div className="text-dim text-sm">Owed at the end of {monthLabel(monthFilter)}</div>
              <div className="tnum text-2xl font-bold text-clay">
                {naira(sum(monthRows, 'closing'))}
              </div>
              <div className="text-dim text-sm mt-1">
                took {naira(sum(monthRows, 'taken'))}
                {' · '}repaid {naira(sum(monthRows, 'repaid'))} during the month
              </div>
              {!!monthStaff.length && (
                <div className="text-dim text-sm mt-1">
                  {naira(sum(monthStaff, 'closing'))} of it is staff
                </div>
              )}
            </div>

            {/* Staff are BACK on this view (Chris, 18 November 2026).
                
                They were taken off this morning because the section read
                as a deduction sheet, and Payroll already is one. That was
                half right: the deduction belongs to Payroll, but SEEING
                who owes does not — and taking the list away took away the
                step before the deduction. In Chris's words: "They should
                be listed as credit and given an opportunity to clear
                their debt; if not, I will manually pull it from their
                payroll."
                
                So the list is here and the money still moves in Payroll.
                Nothing on this page deducts anything. */}
            {section('Staff', monthStaff,
              'Payroll no longer touches credit at all — every repayment is '
              + 'recorded here, like anyone else\'s. This is what each owed when '
              + 'the month closed, to chase.')}

            {section('Customers', monthCustomers,
              'Customers are not deducted from — these are chased. The figure is '
              + 'what each owed when the month closed, in total, not just this '
              + "month's credit. Money paid since is not in it.")}
          </>
        )
      })()}

      {monthFilter ? null : (
      <>
      {/* Money somebody has taken that the books have not accepted. It sits
          above everything, because an unapproved payment is money in a till
          that no figure on this page includes. */}
      {isBoss && !!pending.filter(r => r.status === 'pending').length && (
        <section className="rounded-2xl border border-amber bg-surface p-4 mt-1">
          <div className="text-amber font-bold">
            {pending.filter(r => r.status === 'pending').length} payment
            {pending.filter(r => r.status === 'pending').length === 1 ? '' : 's'} waiting for you
          </div>
          <p className="text-dim text-sm mt-1">
            Taken after the day was closed. Until you decide, this money is in
            nobody's figures.
          </p>
          <ul className="mt-3 divide-y divide-line/60">
            {pending.filter(r => r.status === 'pending').map(r => (
              <li key={r.id} className="py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{r.customer || 'Unknown'}</span>
                  <span className="tnum font-bold text-amber">{naira(r.amount)}</span>
                </div>
                <div className="text-dim text-sm">
                  {r.department ? `${r.department} · ` : ''}{methodLabel[r.method] || r.method}
                  {' · '}for {r.paid_on}, {r.days_late} days ago
                </div>
                <div className="text-dim text-sm">taken by {r.submitted_by || 'someone'}</div>
                {r.note && <div className="text-dim text-sm">“{r.note}”</div>}
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setDeciding({ row: r, reason: '', mode: 'approve' })}
                    className="h-10 px-3 rounded-xl bg-leaf text-bg font-bold text-sm">
                    Let it in
                  </button>
                  <button onClick={() => setDeciding({ row: r, reason: '', mode: 'reject' })}
                    className="h-10 px-3 rounded-xl border border-clay text-clay font-bold text-sm">
                    Turn it away
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The figure this page exists for, at the top of it and in a size
          that matches what it means. It was a small number on the right
          of a heading, the same weight as the headings above it. */}
      <section className="rounded-2xl border border-clay bg-surface p-4 mt-1">
        <div className="text-dim text-sm">
          {locId === 'all' ? 'Owed across all departments' : `Owed to ${locById[locId]?.name || 'this department'}`}
        </div>
        <div className="tnum text-3xl font-bold text-clay">{naira(total)}</div>
        <div className="text-dim text-sm mt-1">
          {owing.length} {owing.length === 1 ? 'person owes' : 'people owe'} it
          {biggest > 0 && <> · biggest {naira(biggest)}</>}
          {oldest && <> · oldest since {new Date(oldest + 'T12:00:00')
            .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</>}
        </div>
        {overAMonth > 0.009 && (
          <div className="text-amber font-semibold text-sm mt-2 pt-2 border-t border-line">
            {naira(overAMonth)} of it has been owed for over a month
            {total > 0 && <span className="text-dim font-normal">
              {' '}· {Math.round((overAMonth / total) * 100)}% of the total</span>}
          </div>
        )}
        {/* All time, and said so. These two are each customer's whole
            history at this department, not this month's — summing them
            under a monthly heading is how a figure gets quoted wrongly. */}
        {takenAllTime > 0 && (
          <div className="text-dim text-xs mt-2 pt-2 border-t border-line">
            {naira(takenAllTime)} given and {naira(repaidAllTime)} paid back by these{' '}
            {owing.length === 1 ? 'person' : 'people'}, all time
          </div>
        )}
      </section>

      {/* Only once the list is long enough to be worth searching. */}
      {owing.length > 4 && (
        <input value={find} onChange={e => setFind(e.target.value)}
          placeholder="Find a name" aria-label="Find a name"
          className="mt-3 h-11 w-full px-3 rounded-xl bg-surface border border-line" />
      )}

      {(() => {
        // Months fold. One row per month carrying its total, the current
        // month open and the rest one tap away.
        //
        // Grouped by the month a person LAST took credit, not the month
        // they started (Chris, 13 November 2026 — "people owing on a daily
        // basis are hidden"). Grouping by the first credit filed a customer
        // who buys every day under whenever they opened their account, so
        // the regulars — the ones you came to the page to see — sat inside
        // a folded September. Last credit puts anyone still active in the
        // open month and lets genuinely dormant debt fold away.
        //
        // The month a debt is DEDUCTED in is a different question, and it
        // has its own view: "what each owed at the end of a month".
        // Staff and customers are two different jobs on one list (Chris,
        // 13 November 2026). Nineteen of the thirty-two people owing on
        // 12 November were staff: that money is deducted at payroll, it is
        // never chased. The rest only arrives if somebody asks for it.
        // Interleaved by date, neither job could be seen whole.
        //
        // Who counts as staff is decided by the same test the month view
        // uses — the name carries "(staff)". Deliberately the same
        // expression as customer_credit_for_month's `name ilike '%staff%'`:
        // two answers to that question on one page would be worse than no
        // split at all. If the test ever changes, change it in both.
        const isStaff = c => /staff/i.test(c.name || '')
        const jobs = [
          { key: 'collect', title: 'Must be collected', caption: 'somebody has to ask',
            rows: shown.filter(c => !isStaff(c)) },
          { key: 'salary', title: 'Staff', caption: 'chased and recorded here, like anyone else',
            rows: shown.filter(isStaff) },
        ].filter(j => j.rows.length)

        // Searching must never fold or file a match out of sight.
        const split = !needle && jobs.length > 1
        // Only "Nothing owing now" folds now, and it starts shut: it is
        // the one group you open to check something rather than to work
        // from. The old default opened whichever group's key ended with
        // the current month, which meant nothing once the month groups
        // were gone.
        // The current month opens by itself, every other month and
        // "Nothing owing now" start shut (Chris, 17 November 2026). The
        // keys are "<job>:<YYYY-MM>", so matching the end of the key
        // catches November under both jobs and nothing else.
        const thisMonth = lagosToday().slice(0, 7)
        const isOpen = k => k in openMonths ? openMonths[k] : k.endsWith(thisMonth)
        const toggle = k => setOpenMonths(o => ({ ...o, [k]: !isOpen(k) }))

        const head = (k, label, count, right, flag) => (
          <button type="button" onClick={() => toggle(k)} aria-expanded={isOpen(k)}
            className="w-full flex items-center gap-2 p-3 rounded-xl bg-raise border border-line text-left">
            <span className="text-dim text-xs w-3 shrink-0">{isOpen(k) ? '▾' : '▸'}</span>
            <span className="flex-1 min-w-0">
              <span className="font-semibold block">{label}</span>
              <span className="text-dim text-xs">
                {count} {count === 1 ? 'person' : 'people'}
                {flag ? <span className="text-amber"> · {flag}</span> : null}
              </span>
            </span>
            {right}
          </button>
        )
        // Cards, like Recovered (Chris, 18 November 2026: "can the
        // Credit page have the same layout as Recovered"). Each person is
        // their own bordered card with their detail inside it, rather
        // than rows separated by hairlines — which is what made a long
        // list read as one undifferentiated block. The left rule and the
        // indent stay: they are what shows these hang under a heading.
        const list = rows => (
          <ul className="space-y-2 pl-3 ml-2 border-l border-line">
            {rows.map(debtorRow)}
          </ul>
        )
        const money = (n, cls) => (
          <span className={`tnum font-bold shrink-0 ${cls}`}>{naira(n)}</span>
        )

        // Months inside a job. Keys are prefixed so October under "must be
        // collected" and October under "comes out of salary" open and close
        // on their own.
        //
        // THE HEADING SAYS WHAT THE MONTH MEANS (Chris, 17 November 2026).
        //
        // These fold by when somebody LAST TOOK credit, not by when the
        // debt arose — and a heading reading only "November 2026" invites
        // the opposite reading. Ella (staff) owed ₦8,800 when October
        // closed and every naira of it sits under November, because she
        // bought a malt on the 16th. Looking at 18 and 21 October showed
        // her owing while no October group existed anywhere, which is
        // not a sum that is wrong but a label that does not say what it
        // is counting.
        // FLAT, NOT FOLDED (Chris, 17 November 2026: "I would like to see
        // everyone still owing on the main list, and if they pay, they are
        // removed from the list" — then, shown the options, "one flat
        // list, no months").
        //
        // The folding was asked for on 13 November, when the worry was a
        // page too long to read. Four days of using it says the cost is
        // higher than the length: 24 debtors sat behind collapsed
        // headings and only the current month opened by itself, so the
        // page answered "who owes" with a row of folders.
        //
        // Worse, the heading could not be made to mean what it said.
        // Folding by LAST credit put Ella's October debt under November
        // because she bought a malt on the 16th; folding by the month
        // the debt was RUN UP would have split one person across several
        // rows. The month question has its own view — "what each owed at
        // the end of a month" — and that is where it belongs.
        //
        // Biggest first: this is the list you work down when you are
        // chasing, and the largest debt is where the money is. Paying
        // still takes somebody off it, into "Nothing owing now".
        // No window on it either (Chris: "October and September
        // inclusive"). loadBalances has never had a date limit, so a debt
        // from 7 September is on this list exactly like one from
        // yesterday — the folding was the only thing that put age between
        // you and it.
        const byMost = rows => [...rows]
          .sort((a, b) => Number(b.balance) - Number(a.balance)
            || String(a.name).localeCompare(String(b.name)))

        // customerId -> { 'YYYY-MM': still owed from that month }, scoped
        // the same way the list itself is, so a department chip narrows
        // both or neither. There is no longer a staff chip to narrow by:
        // who gave the credit is a line on the row, and the question
        // "what is this person carrying" belongs to the month-end sheet,
        // which is where a deduction is decided (Chris, 18 November 2026).
        const owedByMonth = {}
        for (const r of (chain || [])) {
          if (!(Number(r.still_owed) > 0.009)) continue
          if (locId !== 'all' && r.location_id !== locId) continue
          const key = String(r.taken_on || '').slice(0, 7)
          if (key.length !== 7) continue
          const m = owedByMonth[r.customer_id] || (owedByMonth[r.customer_id] = {})
          m[key] = (m[key] || 0) + Number(r.still_owed)
        }

        // A customer's months must add up to that customer's balance. The
        // chain leaves out PR, damage and staff-order sales, so anything
        // it cannot place goes in one bucket rather than quietly
        // vanishing — a page whose parts do not sum to its whole is worse
        // than one that admits a gap.
        const UNPLACED = 'unplaced'
        const monthCache = {}
        const monthsFor = (c) => {
          if (monthCache[c.customer_id]) return monthCache[c.customer_id]
          const m = { ...(owedByMonth[c.customer_id] || {}) }
          const keys = Object.keys(m).sort()          // oldest first
          let placed = keys.reduce((t, k) => t + m[k], 0)
          const bal = Number(c.balance)

          // THE MONTHS MUST ADD UP TO WHAT THE PERSON OWES (Chris, 17
          // November 2026: "Oga Emmy in Awka says 1000 owed in Sep but
          // when you want to collect the payment it says 0 owe").
          //
          // The ladder can only match a repayment to credit given by the
          // SAME person at the SAME department. Money recorded against
          // anyone else leaves the sale standing open in the ladder
          // while the balance — which simply nets credit against
          // repayments — has already come down. That is the same fault
          // the settled group names: "how Mr Michael's debt became
          // invisible when a repayment landed on a barman who had given
          // him no credit."
          //
          // The balance is the truth about what is owed, so the excess is
          // written off against the months oldest first, which is the
          // order money is applied in everywhere else.
          if (placed > bal + 0.009) {
            let excess = placed - bal
            for (const k of keys) {
              if (excess <= 0.009) break
              const take = Math.min(m[k], excess)
              m[k] -= take; excess -= take
              if (m[k] <= 0.009) delete m[k]
            }
            placed = bal
          }

          // And the other way: the ladder leaves out PR, damage and
          // staff-order sales, so whatever it cannot place is shown
          // rather than dropped.
          const rest = bal - placed
          if (rest > 0.009) m[UNPLACED] = rest
          monthCache[c.customer_id] = m
          return m
        }

        // Oldest month first — September, then October, then November —
        // because that is the order you work through them in, and the
        // oldest money is the money least likely to arrive. Anything
        // unplaced sits at the end.
        const monthKeys = (rows) => {
          const seen = new Set()
          for (const c of rows) for (const k of Object.keys(monthsFor(c))) seen.add(k)
          return [...seen].sort((a, b) =>
            a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b))
        }

        // Until the chain has arrived there is nothing to split by, so
        // the page shows the plain list rather than an empty one. Every
        // debtor is still there; only the month headings are missing.
        const grouped = (prefix, rows) =>
          chain === null ? flatList(rows) : monthsOf(prefix, rows)

        const monthsOf = (prefix, rows) => monthKeys(rows).map(key => {
          const inMonth = byMost(rows
            .filter(c => monthsFor(c)[key] > 0.009)
            // __whole keeps the untouched row, because Collect must open
            // on what the person owes, not on one month's slice of it.
            .map(c => ({ ...c, balance: monthsFor(c)[key], __whole: c })))
          if (!inMonth.length) return null
          const k = `${prefix}:${key}`
          return (
            <div key={k}>
              {/* "Still unpaid from October 2026", not "October 2026".
                  Two screens carry an October figure and they are
                  different numbers, both right. THIS one is what is
                  still unpaid from that month as of today — Ella's
                  ₦8,000. The month-end view's October closing is what
                  she owed when October CLOSED — ₦8,800. The gap is the
                  ₦800 she paid on 1 November, which went against her
                  October debt because repayments clear oldest first.
                  Deduct from the wrong one a fortnight later and you
                  take money the person has already handed over, so each
                  heading now says which question it answers. */}
              {head(k,
                key === UNPLACED
                  ? 'Not placed in a month'
                  : `Still unpaid from ${monthLabel(key)}`,
                inMonth.length,
                money(inMonth.reduce((t, r) => t + Number(r.balance), 0), 'text-clay'),
                null)}
              {isOpen(k) && (
                <ul className="space-y-2 pl-3 ml-2 border-l border-line">
                  {inMonth.map(c => debtorRow(c, key === UNPLACED ? null : key))}
                </ul>
              )}
            </div>
          )
        })
        // No left rule and no indent: these rows no longer hang under a
        // month heading, they ARE the list.
        const flatList = rows => (
          <ul className="space-y-2">{byMost(rows).map(debtorRow)}</ul>
        )

        // Nobody drops off the list. An account that is square, or that has
        // paid further than it owes, says so instead of vanishing — which is
        // how Mr Michael's debt became invisible when a repayment landed on
        // a barman who had given him no credit.
        // A SEARCH LOOKS THROUGH EVERYONE, NOT ONLY THE DEBTORS (Kate,
        // via Chris, 18 November 2026).
        //
        // Kate went to collect Ikenna's ₦600 Minimart debt, typed his
        // name, and got nothing back at all: the search above filters
        // `owing`, and this line emptied the settled group whenever
        // there was a needle. So the one person she was looking for was
        // the one person the page could not show her, and the app
        // reads as having lost him.
        //
        // He was square, and for a reason worth seeing: he paid ₦1,000
        // against a ₦400 debt on 9 November, and the ₦600 Gala on the
        // 16th used that credit up. His statement says so in those words
        // — "Covered — they were already in credit" — but only to
        // somebody who can reach it.
        const settled = needle
          ? combined.filter(r => Number(r.balance) <= 0.009
              && (r.name || '').toLowerCase().includes(needle))
          : combined.filter(r => Number(r.balance) <= 0.009)
        const odd = settled.filter(r => Number(r.balance) < -0.009).length
        const settledGroup = !!settled.length && (
          <div className="mt-2">
            {head('settled', needle ? `Nothing owing now · matching “${find}”` : 'Nothing owing now',
              settled.length,
              <span className="tnum font-bold text-leaf shrink-0">
                {odd ? '' : 'square'}
              </span>,
              odd ? `${odd} ${odd === 1 ? 'needs' : 'need'} a look` : null)}
            {/* Open on a search: a name typed in is a deliberate
                lookup, and answering it with a closed fold is the same
                as answering with nothing. */}
            {(needle || isOpen('settled')) && list(settled)}
          </div>
        )

        if (needle || !shown.length) return (
          <>
            <ul className="mt-2 divide-y divide-line/60">
              {shown.map(debtorRow)}
              {!owing.length && <li className="py-8 text-center text-dim">Nobody owes anything.</li>}
              {!!owing.length && !shown.length && (
                <li className="py-8 text-center text-dim">
                  Nobody owing matches “{find}”.
                  {settled.length
                    ? ' Anyone of that name who has paid up is below.'
                    : ` ${owing.length} ${owing.length === 1 ? 'debtor' : 'debtors'} in all.`}
                </li>
              )}
            </ul>
            {settledGroup}
          </>
        )

        // One job only — a barman's debtors are all customers, and a
        // heading over the only list is noise.
        if (!split) return (
          <div className="mt-2 flex flex-col gap-2">
            {grouped(jobs[0]?.key || 'all', shown)}
            {settledGroup}
          </div>
        )

        return (
          <div className="mt-2 flex flex-col gap-3">
            {jobs.map(j => (
              <section key={j.key} className="rounded-2xl border border-line overflow-hidden">
                <div className="flex items-baseline gap-2 px-3 py-2.5 bg-surface border-b border-line">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">{j.title}</div>
                    <div className="text-dim text-xs">
                      {j.rows.length} {j.rows.length === 1 ? 'person' : 'people'} · {j.caption}
                    </div>
                  </div>
                  {money(j.rows.reduce((t, r) => t + Number(r.balance), 0), 'text-clay')}
                </div>
                <div className="p-2 flex flex-col gap-2">{grouped(j.key, j.rows)}</div>
              </section>
            ))}
            {settledGroup}
          </div>
        )
      })()}
      </>
      )}

      {/* Room balances are NOT department credit. Showing them under
          every chip made a guest's room debt look like money owed at
          Minimart or MainBar. Shown under Reception and All
          departments, where they belong; under any other department a
          one-line pointer keeps them findable without pretending they
          belong there. */}
      {!monthFilter && !isReception && (
        <RoomChargeTracker branchId={staff.branch_id} locationId={locId === 'all' ? null : locId} />
      )}
      {!monthFilter && hasReceptionAccess && !isReception && locId !== 'all' && (
        <p className="text-dim text-sm py-3">
          Guest room balances are under Reception.
        </p>
      )}
      {!monthFilter && hasReceptionAccess && (isReception || locId === 'all') && (() => {
        const gb = guestBalances || []
        // Must match what each ROW below displays and what
        // loadReceptionDashboard's deferredTotal uses. Summing only
        // .outstanding made the header disagree with the rows under
        // it for any guest carrying department credit — invisible
        // before migration 224 (front desk got no department rows at
        // all), obvious the moment that data started arriving.
        const gbTotal = gb.reduce((s, r) => s + r.outstanding + r.departmentCredit + r.billedToYou, 0)
        return (
          <>
            <section className="rounded-2xl border border-clay bg-surface p-4 mt-6">
              <div className="text-dim text-sm">Guest room balances</div>
              <div className="tnum text-2xl font-bold text-clay">{naira(gbTotal)}</div>
              <div className="text-dim text-sm mt-1">
                across {gb.length} room{gb.length === 1 ? '' : 's'}
                {canCollect ? ' · tap a room to take payment' : ''}
              </div>
            </section>
            <ul className="divide-y divide-line/60">
              {gb.map(g => (
                <li key={g.stay_id} className="py-3 flex items-center gap-3">
                  <button disabled={!canCollect}
                    onClick={() => setGuestPay({
                      stayId: g.stay_id, guestName: g.guest_name, roomNumber: g.room_number,
                      outstanding: g.outstanding, billingCycle: g.billing_cycle,
                      // Nothing pre-selected — see the note in Folio.
                      amount: String(g.outstanding), method: null, split: null, isOverstay: false,
                    })}
                    className="flex-1 min-w-0 text-left disabled:cursor-default">
                    <div className="font-semibold truncate">{g.guest_name || 'Guest'}</div>
                    <div className="text-dim text-sm">Room {g.room_number}</div>
                    {g.bill_to && (
                      <div className="text-amber text-sm font-semibold">→ Billed to {g.bill_to}</div>
                    )}
                    {g.departmentCredit > 0 && (
                      <div className="text-clay text-sm">
                        incl. {naira(g.departmentCredit)} at other departments
                      </div>
                    )}
                    {g.billedToYou > 0 && (
                      <div className="text-clay text-sm">
                        incl. {naira(g.billedToYou)} from other bills
                      </div>
                    )}
                  </button>
                  <span className="shrink-0 text-right">
                    <span className="tnum font-bold text-clay block">
                      {naira(g.outstanding + g.departmentCredit + g.billedToYou)}
                    </span>
                    <span className="text-dim text-xs">take payment ›</span>
                  </span>
                </li>
              ))}
              {guestBalances !== null && !gb.length && (
                <li className="py-8 text-center text-dim">No room balances outstanding.</li>
              )}
              {guestBalances === null && <li className="py-8 text-center text-dim">Loading…</li>}
            </ul>

            {/* Rooms booked but not yet arrived. Deliberately NOT counted
                above: a reservation is not a debt until the guest checks
                in, and eleven PSN rooms held for November were reading as
                ₦1,650,000 owed — five times every real balance together.
                Still shown, because an unpaid group booking is worth
                seeing while a deposit can still be asked for. */}
            {upcoming.length > 0 && (() => {
              const unpaid = upcoming.filter(u => u.unpaid > 0.009)
              if (!unpaid.length) return null
              return (
                <details className="mt-4 rounded-2xl border border-line bg-surface p-4">
                  <summary className="flex items-baseline justify-between cursor-pointer">
                    <span>
                      <span className="font-semibold">Booked, not yet arrived</span>
                      <span className="text-dim text-sm block">
                        {unpaid.length} room{unpaid.length === 1 ? '' : 's'} · not counted as owing
                      </span>
                    </span>
                    <span className="tnum font-bold text-amber">
                      {naira(unpaid.reduce((s2, u) => s2 + u.unpaid, 0))}
                    </span>
                  </summary>
                  <ul className="mt-3 divide-y divide-line/60">
                    {unpaid.map(u => (
                      <li key={u.stayId} className="py-2 flex items-baseline gap-3 text-sm">
                        <span className="flex-1 min-w-0 truncate">
                          {u.guest}
                          <span className="text-dim"> · Room {u.room} · arrives {u.arrives}</span>
                        </span>
                        <span className="tnum text-dim shrink-0">{naira(u.unpaid)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )
            })()}

            {/* Department accounts owing money but attached to no
                guest. This is the money that goes missing at checkout:
                the room gets settled and a bar or minimart balance in
                the guest's name is never seen, because nothing joins
                the two. Linking one makes it appear on that guest's
                folio from then on. */}
            {!!unlinked?.length && (
              <Notice tone="problem" className="mt-6"
                title="Department accounts not linked to a guest">
                <p className="mb-3">
                  These balances will not show on any guest&#39;s folio at checkout.
                  Link one to the guest it belongs to. If it is a staff tab or somebody
                  who never stays here, mark it <strong>Not a guest</strong> and it will
                  stop appearing — this list is only worth reading when it is short.
                </p>
                {unlinked.map(c => (
                  <div key={c.id} className="flex items-center gap-3 py-2 border-t border-line/60 first:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{c.name}</div>
                      <div className="text-dim text-xs">
                        {c.locationIds.map(id => locById[id]?.name).filter(Boolean).join(', ') || '—'}
                      </div>
                    </div>
                    <span className="tnum font-bold text-clay shrink-0">{naira(c.balance)}</span>
                    <button
                      onClick={() => { setLinkTarget({ customerId: c.id, name: c.name }); setLinking(true) }}
                      className="shrink-0 h-9 px-3 rounded-lg border border-amber text-amber text-sm font-semibold">
                      Link
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(
                            `Mark "${c.name}" as never a guest?\n\n`
                            + `${naira(c.balance)} stays owing and still shows on the Credit page — `
                            + 'it only stops appearing in this warning. Undo it from the account\u2019s statement.')) return
                        try {
                          await setCustomerNeverAGuest(c.id, true)
                          toast(`${c.name} will not be asked about again`, 'success')
                          refreshUnlinked()
                        } catch (e) { toast(e.message, 'error') }
                      }}
                      className="shrink-0 h-9 px-3 rounded-lg border border-line text-dim text-sm font-semibold">
                      Not a guest
                    </button>
                  </div>
                ))}
              </Notice>
            )}
          </>
        )
      })()}

      {open && (
        <div className="fixed inset-0 z-50 bg-bg h-[100dvh] flex flex-col">
          {/* min-h-0 is the one that matters, and it is not cosmetic
              (iPhone, 25 October 2026). `flex-1` is `flex: 1 1 0%`, but a
              flex child still has min-height:auto — so a long statement
              forces this box TALLER than the panel instead of scrolling
              inside it. The panel is pinned to the viewport, so the
              overflow goes off the top and the Back button becomes
              unreachable: you can scroll down and never back up.
              min-h-0 lets it shrink and scroll properly. Applied to every
              panel of this shape in the app, not just this one.

              overscroll-contain: reaching the end of this list must not
              hand the scroll to the page underneath. */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="p-5 print:hidden flex items-center justify-between">
              <button onClick={() => setOpen(null)} className="text-dim">Back</button>
              <div className="flex items-center gap-4">
                {openNotGuest && (
                  <button onClick={async () => {
                      try {
                        await setCustomerNeverAGuest(open.customer.customer_id, false)
                        setOpenNotGuest(false)
                        toast('Back in the unlinked list', 'success')
                        refreshUnlinked()
                      } catch (e) { toast(e.message, 'error') }
                    }}
                    className="text-dim text-sm font-semibold underline">
                    Marked not a guest &middot; undo
                  </button>
                )}
                <button onClick={() => { setLinkTarget({ customerId: open.customer.customer_id, name: open.customer.name }); setLinking(true) }}
                  className="text-amber text-sm font-semibold">
                  Link to a guest
                </button>
              </div>
            </div>

            <div id="statement-area" className="invoice-print px-5 pb-6">
              {/* letterhead */}
              <div className="invoice-head">
                <h1 className="text-2xl font-bold">Havilah Suite Ltd</h1>
                <p className="text-dim">
                  {boot.branchName || ''} · Statement of Account
                  {stmt.groups.length > 1 ? ' · all departments' : ''}
                </p>
              </div>

              <div className="invoice-meta mt-5">
                <div>
                  <div className="text-dim text-sm">Customer</div>
                  <div className="text-xl font-bold">{open.customer.name}</div>
                  {open.customer.phone && <div className="text-dim text-sm">{open.customer.phone}</div>}
                </div>
                <div className="text-right">
                  <div className="text-dim text-sm">Date</div>
                  <div className="tnum">
                    {new Date().toLocaleDateString('en-NG',
                      { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                </div>
              </div>

              {open.error && (
                <p className="text-clay mt-6">
                  This statement could not be loaded — this is not the same as
                  there being nothing on it.
                  <span className="block text-xs mt-1 break-words">{open.error}</span>
                </p>
              )}
              {!open.ledger && !open.error && (
                <p className="text-dim mt-6">Loading this account…</p>
              )}
              {open.ledger && (<>
              {/* Two shapes, one set of figures (Chris, 25 October 2026 —
                  "each item should have who served it", and the statement
                  overflowing on iPhone).

                  Measured: six columns came to 398px of table inside a
                  320px screen, so the statement ran off the side before a
                  Served by column was ever added. A phone gets three
                  columns — day, what it was, how much — with the
                  department, the quantity and the server folded under the
                  item. Wider screens and print get the full invoice
                  columns, because that is what a customer is handed. */}
              <h3 className="mt-6 mb-2 font-bold">Still owed</h3>
              <p className="text-dim text-sm mb-2">
                Only what is unpaid. Anything already settled is not listed.
              </p>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="hidden sm:table-cell print:table-cell">Department</th>
                    <th>Item</th>
                    <th className="hidden sm:table-cell print:table-cell">Served by</th>
                    <th className="num hidden sm:table-cell print:table-cell">Qty</th>
                    <th className="num hidden sm:table-cell print:table-cell">Charged</th>
                    <th className="num">Still owing</th>
                  </tr>
                </thead>
                {/* One body per department, each closing with its own
                    subtotal — a statement covering three bars that gives
                    only a grand total cannot be checked by any one of
                    them. A single-department account gets no subtotal
                    row, because it would only repeat the total below. */}
                {stmt.groups.map(g => (
                <tbody key={g.key}>
                  {stmt.groups.length > 1 && (
                    <tr>
                      <td colSpan="7" style={{ paddingTop: '0.9rem' }} className="font-bold">{g.name}</td>
                    </tr>
                  )}
                  {g.rows.map(r => {
                    const left = Number(r.still_owed || 0)
                    const part = Number(r.recovered || 0) > 0.009
                    return (
                    <tr key={r.sale_id}>
                      <td className="tnum">{String(r.taken_on || '').slice(5)}</td>
                      <td className="hidden sm:table-cell print:table-cell">{r.dept || '—'}</td>
                      <td>
                        {r.item || '—'}
                        {/* Everything the narrow table leaves out, in one
                            line under the item. */}
                        <span className="block text-dim text-xs mt-0.5 sm:hidden print:hidden">
                          {[r.dept, r.qty ? `${r.qty} × ${naira(r.unit_price)}` : null,
                            r.staff && `served by ${r.staff}`,
                          ].filter(Boolean).join(' · ')}
                        </span>
                        {/* A line paid down but not cleared says so on both
                            shapes: "still owing 3,500" against a 3,900 item
                            otherwise reads as an error to whoever checks it. */}
                        {part && (
                          <span className="block text-dim text-xs tnum">
                            {naira(r.recovered)} of {naira(r.amount)} already paid
                          </span>
                        )}
                      </td>
                      <td className="text-dim hidden sm:table-cell print:table-cell">{r.staff || '—'}</td>
                      <td className="num tnum hidden sm:table-cell print:table-cell">{r.qty}</td>
                      <td className="num tnum hidden sm:table-cell print:table-cell">{naira(r.amount)}</td>
                      <td className="num tnum font-semibold">{naira(left)}</td>
                    </tr>
                    )
                  })}
                  {stmt.groups.length > 1 && (
                    <tr>
                      <td colSpan="2" className="num text-dim">{g.name} subtotal</td>
                      <td className="hidden sm:table-cell print:table-cell"></td>
                      <td className="hidden sm:table-cell print:table-cell"></td>
                      <td className="num tnum hidden sm:table-cell print:table-cell"></td>
                      <td className="num tnum hidden sm:table-cell print:table-cell"></td>
                      <td className="num tnum font-semibold">{naira(g.subtotal)}</td>
                    </tr>
                  )}
                </tbody>
                ))}
                <tbody>
                  {!stmt.owing.length && (
                    <tr><td colSpan="7" className="text-dim">Nothing outstanding. This account is settled.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="sm:hidden print:hidden">
                    <td colSpan="2" className="num font-bold">Total still owed</td>
                    <td className="num tnum font-bold">{naira(stmt.totalOwed)}</td>
                  </tr>
                  <tr className="hidden sm:table-row print:table-row">
                    <td colSpan="6" className="num font-bold">Total still owed</td>
                    <td className="num tnum font-bold">{naira(stmt.totalOwed)}</td>
                  </tr>
                </tfoot>
              </table>

              <p className="text-dim text-sm mt-2">
                Money paid is applied to the oldest item still owing first, which is
                how it is settled at the till. A payment is not tied to one item.
              </p>

              <h3 className="mt-6 mb-2 font-bold">
                {stmt.morePays ? 'Recent payments' : 'Payments received'}
              </h3>
              <table className="invoice-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Method</th>
                    <th className="hidden sm:table-cell print:table-cell">Where</th>
                    <th className="hidden sm:table-cell print:table-cell">Taken by</th>
                    <th className="hidden sm:table-cell print:table-cell">Note</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.recent.map(r => (
                    <tr key={r.id}>
                      <td className="tnum">{r.paid_on?.slice(5)}</td>
                      <td>
                        {methodLabel[r.method] || r.method}
                        <span className="block text-dim text-xs mt-0.5 sm:hidden print:hidden">
                          {[locById[r.location_id]?.name,
                            r.taken_by && `taken by ${r.taken_by}`, r.note]
                            .filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td className="text-dim hidden sm:table-cell print:table-cell">{locById[r.location_id]?.name || '—'}</td>
                      <td className="text-dim hidden sm:table-cell print:table-cell">{r.taken_by || '—'}</td>
                      <td className="text-dim hidden sm:table-cell print:table-cell">{r.note || ''}</td>
                      <td className="num tnum">{naira(r.amount)}</td>
                    </tr>
                  ))}
                  {!stmt.recent.length && (
                    <tr><td colSpan="6" className="text-dim">None yet.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  {/* Paid in full, across the whole account — not the sum
                      of the ten rows above it, which would be a different
                      number and a confusing one. */}
                  <tr className="sm:hidden print:hidden">
                    <td colSpan="2" className="num font-bold">Paid to date</td>
                    <td className="num tnum font-bold">{naira(stmt.paidTotal)}</td>
                  </tr>
                  <tr className="hidden sm:table-row print:table-row">
                    <td colSpan="5" className="num font-bold">Paid to date</td>
                    <td className="num tnum font-bold">{naira(stmt.paidTotal)}</td>
                  </tr>
                </tfoot>
              </table>
              {stmt.morePays > 0 && (
                <p className="text-dim text-sm mt-2">
                  The {stmt.recent.length} most recent payments are listed.
                  {' '}{stmt.morePays} earlier payment{stmt.morePays === 1 ? ' is' : 's are'} included in the
                  total but not shown.
                </p>
              )}

              <div className="invoice-balance mt-6">
                <span>{stmt.totalOwed > 0.009 ? 'Balance owing' : 'Balance'}</span>
                <span className="tnum">{naira(stmt.totalOwed)}</span>
              </div>

              {open.customer.balance > 0.009 && locId === 'all' && (
                <p className="print:hidden mt-3 text-dim text-sm">
                  Viewing all departments. To record a payment or move this balance
                  to a room, open the department it was owed at.
                </p>
              )}
              {open.customer.balance > 0.009 && locId !== 'all' && (
                <button onClick={() => setMovingToRoom({ customerId: open.customer.customer_id, locationId: locId,
                                                            amount: open.customer.balance })}
                  className="print:hidden mt-3 h-11 px-4 rounded-xl border border-amber text-amber text-sm font-semibold">
                  Move this balance to a room charge
                </button>
              )}

              <p className="text-dim text-sm mt-6 invoice-foot">
                Prepared from the Havilah inventory system. Please settle at the front desk
                or with the store manager.
              </p>
              </>)}
            </div>

            {/* What was taken, and how each of it came back (570).
                Kept off the printed statement, which is the formal
                account; this is the working view — the one that answers
                "has he paid for the Desperados yet". */}
            {/* The account, month by month — the prototype's shape.
                Built from open.chain, which this sheet already loads, so
                the second request CreditChain used to make is gone. */}
            <div className="px-5 pb-5 print:hidden">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <h3 className="font-semibold">What was taken, month by month</h3>
                {open.chain?.length > 0 && (
                  <span className="text-dim text-xs">oldest first</span>
                )}
              </div>
              {open.error && (
                <p className="text-clay text-sm">
                  The list of what was taken could not be loaded — this is not the
                  same as nothing being taken.
                </p>
              )}
              {!open.error && open.chain === null && (
                <p className="text-dim text-sm">Loading…</p>
              )}
              {!open.error && open.chain?.length === 0 && (
                <p className="text-dim text-sm">Nothing has been taken on this account.</p>
              )}
              {!open.error && !!open.chain?.length && (() => {
                const by = {}
                for (const r of open.chain) {
                  const k = String(r.taken_on || '').slice(0, 7)
                  if (k.length !== 7) continue
                  ;(by[k] || (by[k] = [])).push(r)
                }
                const keys = Object.keys(by).sort()
                const owedAll = open.chain.reduce((t, r) => t + Number(r.still_owed || 0), 0)
                return (
                  <>
                    {canCollect && owedAll > 0.009 && (
                      <button type="button" onClick={() => openPayFor(open.chain, null)}
                        className="w-full h-13 py-3 mb-3 rounded-2xl bg-amber text-bg font-bold">
                        Collect everything · {naira(owedAll)}
                      </button>
                    )}
                    <div className="flex flex-col gap-3">
                      {keys.map(k => {
                        const rows = by[k]
                        const owed = rows.reduce((t, r) => t + Number(r.still_owed || 0), 0)
                        const done = owed <= 0.009
                        return (
                          <section key={k} className="rounded-2xl border border-line bg-surface">
                            <div className="flex items-baseline justify-between gap-3
                                            px-4 py-3 border-b border-line">
                              <h4 className="font-semibold">
                                {done ? monthLabel(k) : `Still unpaid from ${monthLabel(k)}`}
                              </h4>
                              <span className={`tnum font-bold shrink-0 ${done ? 'text-leaf' : 'text-clay'}`}>
                                {done ? 'settled' : naira(owed)}
                              </span>
                            </div>
                            <ul className="divide-y divide-line/60">
                              {rows.map(r => {
                                const left = Number(r.still_owed || 0)
                                const part = left > 0.009 && Number(r.recovered || 0) > 0.009
                                return (
                                  <li key={r.sale_id} className="px-4 py-2.5">
                                    <div className="flex items-baseline justify-between gap-3">
                                      <span className="font-semibold break-words min-w-0">{r.item}</span>
                                      <span className="tnum shrink-0">{naira(r.amount)}</span>
                                    </div>
                                    <div className="text-dim text-sm tnum">
                                      {r.qty ? `${r.qty} × ${naira(r.unit_price)} · ` : ''}
                                      taken {new Date(String(r.taken_on) + 'T12:00:00')
                                        .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                                      {r.dept ? ` · ${r.dept}` : ''}
                                      {r.staff ? ` · ${r.staff}` : ''}
                                    </div>
                                    <div className={`text-sm font-semibold ${left <= 0.009 ? 'text-leaf' : 'text-clay'}`}>
                                      {left <= 0.009
                                        ? (r.cleared_on
                                            ? `Recovered ${new Date(String(r.cleared_on) + 'T12:00:00')
                                                .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}`
                                              + (r.cleared_by ? ` · ${methodLabel[r.cleared_by] || r.cleared_by}` : '')
                                            : 'Covered — they were already in credit')
                                        : part ? `${naira(r.recovered)} back · ${naira(left)} still owing`
                                          : `${naira(left)} still owing`}
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                            {canCollect && !done && (
                              <div className="px-4 py-3">
                                <button type="button" onClick={() => openPayFor(rows, k)}
                                  className="w-full h-12 rounded-xl border border-amber
                                             text-amber font-bold text-sm">
                                  Collect {monthLabel(k)} · {naira(owed)}
                                </button>
                              </div>
                            )}
                          </section>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
            </div>

            {isAdmin && (() => {
              const id = open.customer.customer_id
              const on = noCredit.has(id)
              // It blocks nothing, and is not meant to. Staff pour the
              // drink, write it on paper and key it the next morning, so
              // by the time the app sees a credit sale the credit was
              // given hours ago. What this does is put the name in front
              // of whoever opens the sales page, and onto the list that
              // goes to the bar — which is where it can still change
              // somebody's mind.
              const toggle = async () => {
                try {
                  await setCustomerNoCredit(id, !on)
                  setNoCredit(s => {
                    const next = new Set(s)
                    if (on) next.delete(id); else next.add(id)
                    return next
                  })
                  toast(on ? `${open.customer.name} may take credit again`
                           : `${open.customer.name} is on no credit — the bars will see it`,
                        'success')
                } catch (e) { toast(e.message || 'Could not save', 'error') }
              }
              return (
                <div className="px-5 pb-5 print:hidden flex flex-col gap-3">
                  <button onClick={toggle}
                    className={`w-full h-12 rounded-xl font-semibold border ${
                      on ? 'border-leaf text-leaf' : 'border-clay text-clay'}`}>
                    {on ? 'Allow credit again' : 'Put on no credit'}
                  </button>
                  <button onClick={() => setConfirmDel(open.customer)}
                    className="w-full h-12 rounded-xl border border-clay text-clay font-semibold">
                    Delete customer
                  </button>
                </div>
              )
            })()}
          </div>

          <div className="p-5 border-t border-line flex flex-wrap gap-3 print:hidden">
            <button disabled={!open.ledger}
              onClick={() => savePdf(accountStatementPdf({
              branchName: boot.branchName,
              where: stmt.groups.length > 1 ? 'All departments' : stmt.groups[0]?.name,
              customerName: open.customer.name,
              // Grouped the same way as the screen, so the printed copy
              // and the one on the phone are the same document.
              creditRows: stmt.groups.flatMap(g => g.rows).map(r => ({
                date: String(r.taken_on || '').slice(5),
                department: r.dept || '—',
                // A part-paid line carries its own arithmetic, so a
                // printed "still owing" smaller than the charge cannot
                // read as a mistake.
                item: `${r.item || '—'}${Number(r.recovered || 0) > 0.009
                  ? ` (${naira(r.recovered)} of ${naira(r.amount)} already paid)` : ''}`,
                servedBy: r.staff || '',
                qty: r.qty, unit: r.amount, amount: r.still_owed,
              })),
              creditTotal: stmt.totalOwed,
              payments: stmt.recent.map(r => ({
                date: r.paid_on?.slice(5) || '', method: methodLabel[r.method] || r.method,
                where: locById[r.location_id]?.name || '',
                takenBy: r.taken_by || '', note: r.note || '', amount: r.amount,
              })),
              paidTotal: stmt.paidTotal,
              balance: stmt.totalOwed,
            }), `Statement ${open.customer.name}`)}
              className="flex-1 min-w-[45%] h-14 rounded-2xl border border-line font-bold disabled:opacity-40">Save / share PDF</button>
            <button type="button" disabled={!open.chain?.length} onClick={sendStatement}
              className="flex-1 min-w-[45%] h-14 rounded-2xl border border-line font-bold disabled:opacity-40">
              Send as text
            </button>
            {(() => {
              const hiddenForRole = !canCollect
              // Anyone below GM/admin can't
              // record a repayment that would be credited to a
              // different staff member — the credit stays with
              // whoever originally gave it, so someone else has to
              // collect it. Buttons hides rather than errors on tap.
              // A repayment must be credited to one department. That used
              // to mean hiding this in the all view; it now means
              // KNOWING the department — from the row itself, or from
              // the chooser when the credit is split. The literal 'all'
              // is never passed (17 November 2026).
              const hidden = hiddenForRole || !canTakeFrom(open.customer)
              // More than one person gave this customer credit. Which
              // debt the money settles is a real question with a wrong
              // answer available — crediting it to whoever is holding
              // the phone — so it is asked rather than assumed.
              const split = (open.customer.parts || []).length > 1
              const startPay = (part) => setPay({
                customerId: open.customer.customer_id,
                amount: part ? part.balance : open.customer.balance,
                method: null,
                paidOn: lagosToday(), note: '',
                balance: Number(part ? part.balance : open.customer.balance),
                // Never the literal 'all': payLocationFor only reaches
                // for locId when locId is a real department.
                locationId: (part ? part.location_id : null)
                  || payLocationFor(open.customer),
                creditStaffId: (part ? part.staff_id : open.customer.staff_id) || staff.id,
              })
              return (
                <button onClick={() => (split ? setPayWho(open.customer) : startPay(null))}
                  className={`flex-1 h-14 rounded-2xl bg-amber text-bg font-bold ${
                    hidden ? 'hidden' : ''}`}>Record payment</button>
              )
            })()}
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Delete "{confirmDel.name}"?</h2>
          <p className="text-dim mt-2">
            This only succeeds if the customer has no sales or repayments
            against them, ever. If they do, you'll get an error explaining
            why — deactivate them instead in that case, which removes them
            from future credit sales without touching their history.
          </p>
          <button onClick={async () => {
              setDelBusy(true)
              try {
                await deleteCustomer(confirmDel.customer_id)
                toast('Customer deleted', 'success')
                setConfirmDel(null); setOpen(null); refresh()
              } catch (e) { toast(e.message, 'error') }
              setDelBusy(false)
            }} disabled={delBusy}
            className="mt-6 w-full h-14 rounded-2xl bg-clay text-bg text-lg font-bold disabled:opacity-40">
            {delBusy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button onClick={async () => {
              setDelBusy(true)
              try {
                await deactivateCustomer(confirmDel.customer_id)
                toast('Customer deactivated — hidden from future credit sales', 'success')
                setConfirmDel(null); setOpen(null); refresh()
              } catch (e) { toast(e.message, 'error') }
              setDelBusy(false)
            }} disabled={delBusy}
            className="mt-3 w-full h-12 rounded-xl border border-amber text-amber font-semibold disabled:opacity-40">
            Deactivate instead
          </button>
          <button onClick={() => setConfirmDel(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}

      {/* Which debt does this money settle? Asked only when more than one
          person gave this customer credit — otherwise nothing changes. */}
      {/* The warning Joseph never got. It states what it found and makes
          both answers equally easy — a dialog that only offers "go on"
          is not a check. */}
      {held && (
        <div className="fixed inset-0 z-[70] bg-bg h-[100dvh] flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold text-amber">That day is closed</h2>
          <p className="text-dim mt-3">{held.message}</p>
          <p className="text-dim mt-3">
            The money is not lost. Send it to the GM and it waits to be let in —
            on <b className="text-ink">{held.base.paidOn}</b>, the day it was
            actually taken, not today.
          </p>
          <button onClick={sendToGM} disabled={busy}
            className="mt-8 w-full h-14 rounded-2xl bg-amber text-bg font-bold disabled:opacity-40">
            {busy ? 'Sending…' : 'Send it to the GM'}
          </button>
          <button onClick={() => setHeld(null)} disabled={busy}
            className="mt-3 w-full h-14 rounded-2xl border border-line text-dim font-bold">
            Not now
          </button>
        </div>
      )}

      {deciding && (
        <div className="fixed inset-0 z-[70] bg-bg h-[100dvh] flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">
            {deciding.mode === 'approve' ? 'Let it in' : 'Turn it away'}
          </h2>
          <p className="text-dim mt-3">
            {naira(deciding.row.amount)} from <b className="text-ink">{deciding.row.customer}</b>,
            taken by <b className="text-ink">{deciding.row.submitted_by}</b> for{' '}
            <b className="text-ink">{deciding.row.paid_on}</b>.
          </p>
          <p className="text-dim mt-3">
            {deciding.mode === 'approve'
              ? 'It will be recorded on the day it was taken, under the person who took it, and that day will show a late entry.'
              : 'Say why. The record stays either way — somebody said this money arrived.'}
          </p>
          <input value={deciding.reason}
            onChange={e => setDeciding(d => ({ ...d, reason: e.target.value }))}
            placeholder={deciding.mode === 'approve' ? 'Note (optional)' : 'Why it is being turned away'}
            className="mt-4 h-12 w-full px-3 rounded-xl bg-surface border border-line" />
          <button onClick={() => decide(deciding.mode === 'approve')}
            disabled={busy || (deciding.mode === 'reject' && deciding.reason.trim().length < 6)}
            className={`mt-6 w-full h-14 rounded-2xl font-bold disabled:opacity-40 ${
              deciding.mode === 'approve' ? 'bg-leaf text-bg' : 'border border-clay text-clay'}`}>
            {busy ? 'Saving…' : deciding.mode === 'approve' ? 'Let it in' : 'Turn it away'}
          </button>
          <button onClick={() => setDeciding(null)} disabled={busy}
            className="mt-3 w-full h-14 rounded-2xl border border-line text-dim font-bold">
            Back
          </button>
        </div>
      )}

      {repeat && (
        <div className="fixed inset-0 z-[70] bg-bg h-[100dvh] flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold text-clay">This may already be paid</h2>
          <p className="text-dim mt-3">
            {naira(repeat.amount)} was already recorded against this customer on{' '}
            <b className="text-ink">{repeat.paidOn}</b>
            {repeat.who ? <> by <b className="text-ink">{repeat.who}</b></> : null}
            {repeat.method ? ` · ${methodLabel[repeat.method] || repeat.method}` : ''}.
          </p>
          <p className="text-dim mt-3">
            If this is a second, separate payment of the same amount, go ahead.
            If it is the same money being entered again, stop — recording it
            twice takes the debt down twice and the customer is owed the difference.
          </p>
          <button
            onClick={() => { setRepeat(null); submitPayment(true) }}
            className="mt-8 w-full h-14 rounded-2xl border border-clay text-clay font-bold">
            It is a separate payment — record it
          </button>
          <button onClick={() => { setRepeat(null); setPay(null) }}
            className="mt-3 w-full h-14 rounded-2xl bg-amber text-bg font-bold">
            Stop, let me check
          </button>
        </div>
      )}

      {payWho && (
        <div className="fixed inset-0 z-[60] bg-bg h-[100dvh] flex flex-col">
          <div className="p-5 flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <button onClick={() => setPayWho(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">Settle one person's debt</h2>
            <p className="text-dim mt-2">
              {payWho.name} owes {naira(payWho.balance)} in all, given by more than
              one person. Going back clears the oldest debt first and needs no
              choice. Pick someone here only if this money is meant for their
              debt alone — anything left over is a second entry.
            </p>
            <ul className="mt-5 divide-y divide-line/60 rounded-2xl border border-line bg-surface px-4">
              {(payWho.parts || []).map((part, i) => {
                // The same rule the single-slice button uses: someone who
                // may not act on another's behalf cannot collect a debt
                // that belongs to them.
                const blocked = !canCollect
                return (
                  <li key={i} className="py-3">
                    <button
                      disabled={blocked}
                      onClick={() => {
                        setPay({ customerId: payWho.customer_id, amount: part.balance,
                          method: null,
                          paidOn: lagosToday(), note: '', balance: Number(part.balance),
                          // The chosen part always carries its own
                          // department; payLocationFor is the guard, not the
                          // source, and never yields 'all'.
                          locationId: part.location_id || payLocationFor(payWho),
                          creditStaffId: part.staff_id || staff.id })
                        setPayWho(null)
                      }}
                      className="w-full flex items-baseline gap-3 text-left disabled:opacity-40">
                      <span className="flex-1 min-w-0">
                        <span className="font-semibold break-words block">
                          {part.staff_name || 'Not recorded'}
                        </span>
                        <span className="text-dim text-sm block">
                          {locById[part.location_id]?.name || '—'}
                          {i === 0 ? ' · the older debt' : ''}
                        </span>
                        {blocked && (
                          <span className="text-clay text-sm block">
                            Only they can collect this one.
                          </span>
                        )}
                      </span>
                      <span className="tnum font-bold shrink-0 text-clay">{naira(part.balance)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}

      {receipt && (
        <div className="fixed inset-0 z-[70] bg-bg overflow-y-auto p-5">
          <button onClick={() => setReceipt(null)} className="text-dim">Done</button>
          <div className="mt-4 rounded-2xl border border-leaf bg-surface p-4">
            <div className="text-dim text-sm">Payment recorded</div>
            <div className="tnum text-3xl font-bold text-leaf">{naira(receipt.amount)}</div>
            <div className="text-dim text-sm mt-1">
              {receipt.name} · {receipt.methods
                .map(m => `${naira(m.amount)} ${methodLabel[m.method] || m.method}`)
                .join(' + ')}
            </div>
          </div>

          {(() => {
            const by = {}
            for (const c of receipt.cleared) (by[c.month] || (by[c.month] = [])).push(c)
            return Object.keys(by).sort().map(k => (
              <div key={k} className="mt-3 rounded-2xl border border-line bg-surface p-4">
                <div className="text-dim text-xs uppercase tracking-wide mb-2">
                  Cleared in {monthLabel(k)}
                </div>
                <ul className="flex flex-col gap-1">
                  {by[k].map((c, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-dim min-w-0 break-words">
                        {c.item}{c.dept ? ` · ${c.dept}` : ''}
                      </span>
                      <span className="tnum shrink-0">{naira(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          })()}

          <p className="text-dim text-sm mt-4">
            Only the debts listed here were settled. Anything owed in another month is
            exactly where it was.
          </p>
          <button onClick={() => setReceipt(null)}
            className="mt-5 w-full h-14 rounded-2xl bg-amber text-bg font-bold">Done</button>
        </div>
      )}

      {pay && (
        <div className="fixed inset-0 z-[60] bg-bg h-[100dvh] flex flex-col">
          <div className="p-5 flex-1 min-h-0 overflow-y-auto">
            <button onClick={() => setPay(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">Record payment</h2>

            <p className="text-dim mt-2">
              Owing {naira(pay.balance ?? 0)}. Enter less than this for a part payment —
              the rest stays on their account.
            </p>

            <label className="block mt-6 text-dim">Amount</label>
            <input type="number" inputMode="decimal" value={pay.amount}
              onChange={e => setPay(p => ({ ...p, amount: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

            {/* Which month is being cleared, said at the top of the sheet
                rather than left to be inferred from a list of ticks. */}
            {pay.fromMonth && (
              <div className="mt-3 rounded-2xl border border-amber bg-surface p-4">
                <div className="text-amber font-semibold">
                  Clearing {monthLabel(pay.fromMonth)}
                </div>
                <p className="text-dim text-sm mt-1">
                  This settles that month's own debts, oldest first. Nothing in any
                  other month is touched by it.
                </p>
              </div>
            )}

            {/* Shown BEFORE saving, because money landing on the wrong
                person's slate is the fault this whole rule exists to
                stop, and a rule nobody can see is one nobody can
                check. */}
            {pay.spread && (
              <div className="mt-3 rounded-2xl border border-line bg-surface p-4">
                <div className="text-dim text-sm">Where this goes</div>
                <ul className="mt-2 space-y-1">
                  {splitRepaymentByCredit(pay.spread, pay.amount, staff.id).map((p, i) => {
                    const who = (pay.spread || []).find(
                      x => x.staffId === p.staffId && x.locationId === p.locationId)
                    return (
                      <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="text-dim truncate">
                          {who?.staffName || 'Not recorded'}
                          {' · '}{locById[p.locationId]?.name || '—'}
                        </span>
                        <span className="tnum shrink-0">{naira(p.amount)}</span>
                      </li>
                    )
                  })}
                </ul>
                <p className="text-dim text-xs mt-2">
                  Oldest debt first — a repayment goes back to whoever gave the credit.
                </p>
                <button type="button"
                  onClick={() => { const w = pay.whole; setPay(null); setPayWho(w) }}
                  className="text-amber text-sm font-semibold mt-2">
                  Settle one person's debt only ›
                </button>
              </div>
            )}

            <label className="block mt-4 text-dim">Paid by</label>
            <div className="mt-2">
              {/* POS and Cash, and Split means those two (Chris, 18
                  November 2026). Debt does not come back by transfer
                  here, and an unused third button is one more wrong tap
                  at a bar at night. Fixed rather than read from the
                  branch's configured methods, matching the folio and the
                  room payment, which have been fixed this way all
                  along. */}
              <PaymentMethodPicker methods={['pos', 'cash']} amount={pay.amount}
                value={pay}
                onChange={v => setPay(p => ({ ...p, ...v }))} />
            </div>

            <label className="block mt-4 text-dim">Date received</label>
            <input type="date" value={pay.paidOn}
              onChange={e => setPay(p => ({ ...p, paidOn: e.target.value }))}
              className="mt-2 h-14 px-4 rounded-xl bg-surface border border-line tnum" />

            <label className="block mt-4 text-dim">Note (optional)</label>
            <input value={pay.note} onChange={e => setPay(p => ({ ...p, note: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line" />

            {/* "A customer sometimes wants to clear a particular debt"
                (Chris, 13 November 2026). Until now the money always went
                to the oldest credit first and the customer's statement
                would tell him something he would dispute.
                
                Safe for bar staff because they pick a THING, not a
                person: the line knows who served it, so the money is
                credited to whoever gave that credit automatically. That
                is more accurate than oldest-first, not less. */}
            {(() => {
              const owedLines = (open?.chain || []).filter(c =>
                Number(c.still_owed) > 0.009
                && (!pay.locationId || c.location_id === pay.locationId))
              if (!owedLines.length) return null
              const t = pay.targets
              const chosen = Object.entries(t || {})
              const allocated = chosen.reduce((s2, [, v]) => s2 + (Number(v) || 0), 0)
              const target = Number(pay.amount) || 0
              const gap = target - allocated
              return (
                <>
                  <button type="button"
                    onClick={() => setPay(p => ({ ...p,
                      targets: p.targets ? null : {}, split: p.targets ? p.split : null }))}
                    className={`mt-5 w-full h-12 rounded-xl border font-semibold ${t
                      ? 'bg-raise border-amber text-amber' : 'border-line text-dim'}`}>
                    {t ? 'Clearing particular debts' : 'They are paying for something particular'}
                  </button>

                  {t && (
                    <div className="mt-3">
                      <p className="text-dim text-sm mb-2">
                        Tap what they are paying for. A split works here too — the
                        payment is divided across these debts, oldest first.
                      </p>
                      <ul className="divide-y divide-line/60">
                        {owedLines.map(c => {
                          const on = c.sale_id in t
                          return (
                            <li key={c.sale_id} className="py-2">
                              <button type="button"
                                onClick={() => setPay(p => {
                                  const next = { ...(p.targets || {}) }
                                  if (c.sale_id in next) delete next[c.sale_id]
                                  else {
                                    const left = (Number(p.amount) || 0)
                                      - Object.values(next).reduce((a, v) => a + (Number(v) || 0), 0)
                                    next[c.sale_id] = String(Math.max(0,
                                      Math.min(Number(c.still_owed), left)))
                                  }
                                  return { ...p, targets: next }
                                })}
                                className="w-full text-left flex items-baseline gap-3">
                                <span className={`w-5 h-5 shrink-0 rounded border grid place-items-center
                                  text-xs font-bold ${on
                                    ? 'bg-amber border-amber text-bg' : 'border-line text-transparent'}`}>
                                  ✓
                                </span>
                                <span className="flex-1 min-w-0">
                                  <span className="font-semibold">{c.item}</span>
                                  <span className="text-dim text-sm block">
                                    {c.taken_on}{c.staff ? ` · ${c.staff}` : ''}
                                  </span>
                                </span>
                                <span className="tnum font-bold text-clay shrink-0">
                                  {naira(Number(c.still_owed))}
                                </span>
                              </button>
                              {on && (
                                <div className="flex items-center gap-2 mt-2 pl-8">
                                  <span className="text-dim text-sm">Paying</span>
                                  <input inputMode="decimal" value={t[c.sale_id]}
                                    onChange={e => setPay(p => ({ ...p,
                                      targets: { ...(p.targets || {}), [c.sale_id]: e.target.value } }))}
                                    className="h-10 w-32 px-3 rounded-lg bg-raise border border-line tnum" />
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      <p className={`text-sm mt-2 ${Math.abs(gap) < 0.01 ? 'text-leaf' : 'text-clay'}`}>
                        {!(target > 0) ? 'Enter the amount above first.'
                          : Math.abs(gap) < 0.01 ? `The debts chosen add up to ${naira(target)}.`
                          : gap > 0 ? `${naira(gap)} still to put against a debt`
                          : `${naira(-gap)} more than the amount above`}
                      </p>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
          <div className="p-5 border-t border-line">
            {paymentAllocated(pay, pay.amount) > Number(pay.balance ?? 0) + 0.01 && (
              <p className="mt-4 text-clay">
                That is more than they owe. It will leave a credit balance.
              </p>
            )}
            {(() => {
              const target = Number(pay.amount) || 0
              const short = pay.split
                && Math.abs(paymentAllocated(pay, pay.amount) - target) >= 0.01
              const tAlloc = pay.targets
                ? Object.values(pay.targets).reduce((a, v) => a + (Number(v) || 0), 0)
                : 0
              const tShort = !!pay.targets && Math.abs(tAlloc - target) >= 0.01
              const ready = pay.targets
                ? (target > 0 && !tShort && !short && (pay.split ? true : !!pay.method))
                : paymentReady(pay, pay.amount)
              return (
                <button onClick={() => submitPayment()}
                  disabled={busy || !ready}
                  className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
                  {busy ? 'Saving…'
                    : !(pay.split || pay.method) ? 'Choose how they paid'
                    : !(target > 0) ? 'Enter the amount'
                    : short ? `Split must add up to ${naira(target)}`
                    : tShort ? `The debts chosen must add up to ${naira(target)}`
                    : 'Save payment'}
                </button>
              )
            })()}
          </div>
        </div>
      )}
      {guestPay && (
        <div className="fixed inset-0 z-[60] bg-bg h-[100dvh] flex flex-col">
          <div className="p-5 flex-1 min-h-0 overflow-y-auto">
            <button onClick={() => setGuestPay(null)} className="text-dim">Back</button>
            <h2 className="mt-3 text-2xl font-bold">{guestPay.guestName || 'Guest'}</h2>
            <p className="text-dim">Room {guestPay.roomNumber}</p>

            <p className="text-dim mt-4">
              Owing {naira(guestPay.outstanding)}. Enter less than this for a part payment —
              the rest stays on the bill.
            </p>

            <label className="block mt-6 text-dim">Amount</label>
            <input type="number" inputMode="decimal" value={guestPay.amount}
              onChange={e => setGuestPay(p => ({ ...p, amount: e.target.value }))}
              className="mt-2 h-14 w-full px-4 rounded-xl bg-surface border border-line tnum" />

            <label className="block mt-4 text-dim">Paid by</label>
            <div className="mt-2">
              <PaymentMethodPicker methods={['pos', 'cash']} amount={guestPay.amount}
                value={guestPay} onChange={v => setGuestPay(p => ({ ...p, ...v }))} />
            </div>

            <label className="flex items-center gap-2 text-dim mt-4">
              <input type="checkbox" checked={guestPay.isOverstay}
                onChange={e => setGuestPay(p => ({ ...p, isOverstay: e.target.checked }))} />
              Over-stay payment
            </label>

            <button onClick={printGuestStatement} disabled={statementBusy}
              className="mt-4 text-dim text-sm underline disabled:opacity-40">
              {statementBusy ? 'Loading…' : 'Print guest statement'}
            </button>
          </div>
          <div className="p-5 border-t border-line">
            {Number(guestPay.amount) > guestPay.outstanding + 0.01 && (
              <p className="mb-4 text-clay">That is more than is owed. It will leave a credit balance.</p>
            )}
            <button onClick={submitGuestPayment}
              disabled={busy || !paymentReady(guestPay, guestPay.amount)}
              className="w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
              {busy ? 'Saving…'
                : !(guestPay.split || guestPay.method) ? 'Choose how they paid'
                : !(Number(guestPay.amount) > 0) ? 'Enter the amount'
                : guestPay.split && Math.abs(
                    paymentAllocated(guestPay, guestPay.amount) - Number(guestPay.amount)) >= 0.01
                  ? `Split must add up to ${naira(Number(guestPay.amount))}`
                : 'Save payment'}
            </button>
          </div>
        </div>
      )}

      {guestStatement && (
        <FolioStatement room={guestStatement.room} folio={guestStatement.folio}
          moves={guestStatement.moves}
          orderLines={guestStatement.orderLines} payments={guestStatement.payments}
          departmentCredit={guestStatement.departmentCredit} billedToYou={guestStatement.billedToYou}
          branchName={boot.branchName} onClose={() => setGuestStatement(null)} />
      )}

      {linking && (
        <div className="fixed inset-0 z-[80] bg-bg flex flex-col px-6 pt-6">
          <button onClick={() => { setLinking(false); setLinkTarget(null); setLinkQuery(''); setLinkResults([]) }}
            className="text-dim self-start">Close</button>
          <h2 className="mt-3 text-2xl font-bold">Link to a guest</h2>
          <p className="text-dim mt-2">
            Connects {linkTarget?.name} to a real guest record, so their
            department credit shows up on that guest's own folio and
            statement — not just here.
          </p>
          <input value={linkQuery} onChange={e => setLinkQuery(e.target.value)} autoFocus
            placeholder="Search by name"
            className="mt-4 h-14 w-full px-4 rounded-xl bg-surface border border-line placeholder:text-dim" />
          <div className="mt-2 divide-y divide-line">
            {linkResults.map(g => (
              <button key={g.id} disabled={linkBusy} onClick={() => confirmLink(g)}
                className="block w-full text-left py-3">
                <div className="font-semibold">{g.full_name}</div>
                {g.phone && <div className="text-dim text-sm">{g.phone}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {movingToRoom && (
        <div className="fixed inset-0 z-[80] bg-bg flex flex-col justify-center px-6">
          <h2 className="text-2xl font-bold">Move {naira(movingToRoom.amount)} to a room charge?</h2>
          <p className="text-dim mt-2">
            Creates a real charge on this guest's current room, and clears this
            department balance since it's no longer owed here separately.
            The guest must already be linked and have a live stay — if not,
            this will tell you which.
          </p>
          <p className="text-clay mt-3 font-semibold">This cannot be undone.</p>
          <button onClick={confirmMoveToRoom} disabled={moveBusy}
            className="mt-6 w-full h-16 rounded-2xl bg-amber text-bg text-xl font-bold disabled:opacity-40">
            {moveBusy ? 'Moving…' : 'Move to room charge'}
          </button>
          <button onClick={() => setMovingToRoom(null)} className="mt-3 w-full h-12 text-dim">Cancel</button>
        </div>
      )}
    </div>
  )
}
