import { useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { lineTotals } from '../lib/payroll'
import { loadMyCredit } from '../lib/data'
import Notice from '../components/Notice'

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December']

const shortDay = (d) => new Date(d + 'T12:00:00')
  .toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })

// A section that opens on a tap. Written here rather than shared,
// because this page's folds hold a person's own pay and the wording in
// them is particular to that (18 October 2026).
function Fold({ title, right, children, open, onToggle, tone = 'border-line' }) {
  return (
    <section className={`mt-3 rounded-2xl border ${tone} bg-surface p-4`}>
      <button type="button" onClick={onToggle} aria-expanded={!!open}
        className="w-full text-left flex items-baseline justify-between gap-3">
        <span className="font-semibold">{title}</span>
        <span className="flex items-baseline gap-2 shrink-0">
          {right}
          <svg viewBox="0 0 20 20" className={`w-4 h-4 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
               fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && <div className="mt-3 pt-3 border-t border-line">{children}</div>}
    </section>
  )
}

function Row({ label, v, plus, minus }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim min-w-0">{label}</span>
      <span className={`tnum shrink-0 ${minus ? 'text-clay' : plus ? 'text-leaf' : ''}`}>
        {minus ? '−' : plus ? '+' : ''}{naira(v)}
      </span>
    </div>
  )
}

function Fig({ label, value, tone = '' }) {
  return (
    <div className="min-w-0">
      <div className="text-dim text-sm">{label}</div>
      <div className={`tnum font-bold truncate ${tone}`}>{naira(value)}</div>
    </div>
  )
}

// A line of days worked, drawn rather than described. A person knows
// what two-thirds of a month looks like faster than they read "17 of
// 26 days recorded".
function DaysBar({ worked, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((worked / total) * 100)) : 0
  return (
    <div className="mt-3">
      <div className="flex justify-between text-sm">
        <span className="text-dim">Days recorded</span>
        <span className="tnum">{worked} of {total}</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-raise overflow-hidden">
        <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// This month's staff credit, live.
//
// Payroll deducts staff credit at the end of the month from the customer
// account on payroll_employee.customer_id. Until now a person only saw
// that figure after it had been taken, which is how a large deduction
// arrives as a shock. This shows the same account as it fills.
//
// It deliberately shows NO projected take-home beyond salary less
// credit. Contributions, the pot and savings are decided when the month
// is finalised; a number shown now would move later, and the first
// figure someone sees is the one they remember and argue from.
function ThisMonth({ branchId, branchName }) {
  const [c, setC] = useState(null)
  const [err, setErr] = useState(null)
  const [openTook, setOpenTook] = useState(false)
  const [openPaid, setOpenPaid] = useState(false)

  // Never swallow this. A silent blank on a pay page reads as "you owe
  // nothing", which is a claim rather than an absence — the first
  // version hid a broken query behind an empty space.
  // Scoped to the branch being viewed. The GM holds records at both, and
  // one card adding them together showed a single salary and a mixed
  // list with no way to tell which branch either belonged to.
  useEffect(() => {
    setC(null); setErr(null)
    loadMyCredit(branchId).then(c2 => { setC(c2); setErr(null) })
      .catch(e => setErr(e.message || 'could not load'))
  }, [branchId])

  if (err) {
    return (
      <Notice tone="problem" title="This month could not be loaded" className="mt-4">
        <p>
          Your credit for this month is not showing. It does not mean you owe
          nothing — ask the GM to check.
        </p>
        <p className="text-xs mt-2 break-words">{err}</p>
      </Notice>
    )
  }
  if (!c || !c.linked) return null

  if (!c.has_account) {
    // Silence would read as "I owe nothing", which is a different claim.
    return (
      <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
        <p className="font-bold">
          This month
          {branchName && <span className="text-dim text-sm font-normal"> · {branchName}</span>}
        </p>
        <p className="text-dim text-sm mt-1">
          No credit account is linked to you at this branch, so nothing can be shown here.
          If you take items on credit, ask the GM to link your account.
        </p>
      </section>
    )
  }

  const owing = Number(c.outstanding || 0)
  const salary = Number(c.monthly_salary || 0)
  const hasDays = c.days_worked != null && Number(c.working_days) > 0
  const items = c.items || []
  const repayments = c.repayments || []
  const given = c.given || []
  const givenTotal = Number(c.given_total || 0)
  const likely = Math.max(0, salary - owing)

  return (
    <>
      {/* The question this page is opened to answer, at the top of it.
          It used to sit below the credit figure, three scrolls down. */}
      <section className="mt-4 rounded-2xl border border-amber bg-surface p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-bold text-lg">
            This month so far
            {branchName && <span className="text-dim text-sm font-normal"> · {branchName}</span>}
          </p>
          <span className="text-dim text-sm tnum shrink-0">from {shortDay(c.month_from)}</span>
        </div>

        {salary > 0 ? (
          <>
            <div className="text-dim text-sm mt-3">If you work the full month, about</div>
            <div className="tnum text-3xl font-bold text-amber">{naira(likely)}</div>
            <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line">
              <Fig label="Salary, full month" value={salary} />
              <Fig label="Your credit, to come off" value={owing}
                   tone={owing > 0.009 ? 'text-clay' : 'text-leaf'} />
            </div>
          </>
        ) : (
          <>
            <div className="text-dim text-sm mt-3">Your own credit — still to come off your pay</div>
            <div className={`tnum text-3xl font-bold ${owing > 0.009 ? 'text-clay' : 'text-leaf'}`}>
              {naira(owing)}
            </div>
          </>
        )}

        {owing <= 0.009 && (
          <p className="text-leaf text-sm mt-2">Nothing owing. All of your pay is yours.</p>
        )}

        {hasDays
          ? <DaysBar worked={Number(c.days_worked)} total={Number(c.working_days)} />
          : (
            <p className="text-dim text-sm mt-3">
              Your days for this month are not counted yet. Days not worked
              reduce what you receive.
            </p>
          )}

        <p className="text-dim text-xs mt-3">
          An estimate, not a pay slip. Any pot, contribution or savings is worked
          out when the month is finished, and days not worked reduce it. If
          something below is not yours, say so now rather than at month end.
        </p>
      </section>

      {/* The detail, folded. Same three lists as before — a person who
          wants to check an item still can, in one tap, and a person who
          only wants the figure is not made to scroll past them. */}
      {items.length > 0 && (
        <Fold title="What you took this month" open={openTook} onToggle={() => setOpenTook(o => !o)}
          right={<span className="tnum text-clay">−{naira(Number(c.taken_this_month || 0))}</span>}>
          <ul className="divide-y divide-line/60">
            {items.map((it, i) => (
              <li key={i} className="py-1.5 flex items-baseline gap-3 text-sm">
                <span className="text-dim tnum shrink-0 w-14">{shortDay(it.date)}</span>
                <span className="flex-1 min-w-0 break-words">
                  {Number(it.qty) > 1 ? `${Number(it.qty)} × ` : ''}{it.item}
                  {it.department && <span className="text-dim"> · {it.department}</span>}
                </span>
                <span className="tnum shrink-0">{naira(Number(it.amount))}</span>
              </li>
            ))}
          </ul>
        </Fold>
      )}

      {repayments.length > 0 && (
        <Fold title="What you paid back" open={openPaid} onToggle={() => setOpenPaid(o => !o)}
          right={<span className="tnum text-leaf">+{naira(Number(c.repaid_this_month || 0))}</span>}>
          <ul className="divide-y divide-line/60">
            {repayments.map((r, i) => (
              <li key={i} className="py-1.5 flex items-baseline gap-3 text-sm">
                <span className="text-dim tnum shrink-0 w-14">{shortDay(r.date)}</span>
                <span className="flex-1 min-w-0 break-words text-dim">
                  {r.note || (r.method === 'payroll' ? 'Taken from your pay' : r.method?.toUpperCase())}
                </span>
                <span className="tnum text-leaf shrink-0">{naira(Number(r.amount))}</span>
              </li>
            ))}
          </ul>
        </Fold>
      )}

      {/* Credit this person GAVE at the till. Its own card now, not a
          block inside the pay card: it is the business's money to
          recover, not theirs to repay, and anything sharing a border
          with "what comes off your pay" will eventually be read as
          part of it. */}
      {given.length > 0 && (
        <section className="mt-4 rounded-2xl border border-leaf bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-bold">Credit you gave to customers</p>
            <span className="tnum font-bold text-amber shrink-0">{naira(givenTotal)}</span>
          </div>
          <p className="text-dim text-sm mt-1">
            Money customers owe the business, recorded by you. This is{' '}
            <span className="text-leaf font-semibold">not</span> taken off your
            pay — it is yours to collect.
          </p>
          <ul className="mt-3 divide-y divide-line/60">
            {given.map((g, i) => (
              <li key={i} className="py-1.5 flex items-baseline gap-3 text-sm">
                <span className="flex-1 min-w-0 break-words">{g.customer}</span>
                {g.last_credit && (
                  <span className="text-dim text-xs tnum shrink-0">{shortDay(g.last_credit)}</span>
                )}
                <span className="tnum text-amber shrink-0">{naira(Number(g.balance))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// A finished month: the figure received, and the whole working behind
// it one tap away. The most recent opens by default — it is the one
// people check — and the rest stay shut so a year of history is a
// readable list rather than a scroll.
function FinishedMonth({ m, showBranch, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const t = lineTotals(m, m.pot, m.working_days)
  const extra = [...(m.payroll_addition || [])]
  const deductions = m.payroll_deduction || []

  return (
    <section className="mt-3 rounded-2xl border border-line bg-surface p-4">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full text-left">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-bold min-w-0">
            {MONTHS[m.month - 1]} {m.year}
          </h2>
          <span className="flex items-baseline gap-2 shrink-0">
            <span className="tnum text-xl font-bold text-amber">{naira(t.net)}</span>
            <svg viewBox="0 0 20 20" className={`w-4 h-4 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
                 fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        <div className="text-dim text-sm">
          You received · {m.days_worked} of {m.working_days} days
          {showBranch && m.branch && <> · {m.branch}</>}
        </div>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-line space-y-1 text-sm">
          <Row label={`Pay for ${m.days_worked} days (salary ${naira(m.monthly_salary)})`} v={t.earned} />
          {Number(m.additions) > 0 && <Row label="Addition" v={Number(m.additions)} plus />}
          {extra.map((a, i) => (
            <Row key={i} plus v={Number(a.amount)}
                 label={a.note || (a.source === 'award' ? 'Staff of the Month prize' : 'Addition')} />
          ))}
          {deductions.map((d, i) => (
            <Row key={i} minus v={Number(d.amount)}
                 label={d.note || (d.source === 'credit' ? 'Credit taken'
                        : d.source === 'advance' ? 'Salary advance' : 'Deduction')} />
          ))}
          {t.contribution > 0 && <Row label="Paid into the contribution pot" v={t.contribution} minus />}
          {t.pot > 0 && <Row label="Received from the pot" v={t.pot} plus />}
          {t.savings > 0 && <Row label="Held as your savings" v={t.savings} minus />}
          <div className="pt-2 mt-2 border-t border-line flex justify-between gap-3 font-bold">
            <span className="min-w-0">What reached you</span>
            <span className="tnum shrink-0 text-amber">{naira(t.net)}</span>
          </div>
          {m.remark && <p className="mt-2 text-dim text-xs">{m.remark}</p>}
        </div>
      )}
    </section>
  )
}

export default function MyPay({ data, boot }) {
  const branchId = boot?.staff?.branch_id || null
  const branchName = boot?.branchName || null
  if (!data) return <p className="px-5 text-dim">Loading…</p>
  if (!data.linked) {
    return <p className="px-5 py-8 text-center text-dim">
      Your login is not linked to a pay record yet. Ask the GM.</p>
  }
  if (!data.months.length) {
    return (
      <div className="px-5 pb-8">
        <p className="text-dim text-sm py-2">Only you can see this.</p>
        <ThisMonth branchId={branchId} branchName={branchName} />
        <p className="py-8 text-center text-dim">
          No finished month yet. Your pay slip shows here once the month is finalised.
        </p>
      </div>
    )
  }

  // The finished months follow the branch switch too, matched on id —
  // the switcher shows "AWKA" while the branch is "Havilah Suite Awka",
  // so names cannot be compared. Before any month carries a branch_id
  // (an older my_pay), nothing is filtered rather than everything hidden.
  const hasIds = data.months.some(m => m.branch_id)
  const months = (hasIds && branchId)
    ? data.months.filter(m => m.branch_id === branchId)
    : data.months
  const manyBranches = new Set(months.map(m => m.branch)).size > 1

  // Paid across the finished months shown. A year of pay slips with no
  // total is a filing cabinet; one line makes it a record.
  const paidTotal = months.reduce((s, m) => s + lineTotals(m, m.pot, m.working_days).net, 0)

  return (
    <div className="px-5 pb-8">
      <p className="text-dim text-sm py-2">Only you can see this.</p>
      <ThisMonth branchId={branchId} branchName={branchName} />

      <div className="flex items-baseline justify-between gap-3 pt-6">
        <p className="text-dim text-sm">
          Finished months{branchName ? ` · ${branchName}` : ''}
        </p>
        {months.length > 1 && (
          <p className="text-dim text-sm tnum shrink-0">
            {naira(paidTotal)} over {months.length} months
          </p>
        )}
      </div>

      {!months.length && (
        <p className="text-dim text-sm py-6 text-center">
          No finished month at this branch.
        </p>
      )}

      {months.map((m, i) => (
        <FinishedMonth key={`${m.year}-${m.month}-${m.branch}`} m={m}
          showBranch={manyBranches} defaultOpen={i === 0} />
      ))}
    </div>
  )
}
