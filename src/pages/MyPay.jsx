import { useEffect, useState } from 'react'
import { naira } from '../lib/format'
import { lineTotals } from '../lib/payroll'
import { loadMyCredit } from '../lib/data'

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December']

// This month's staff credit, live.
//
// Payroll deducts staff credit at the end of the month from the customer
// account on payroll_employee.customer_id. Until now a person only saw
// that figure after it had been taken, which is how a large deduction
// arrives as a shock. This shows the same account as it fills.
//
// It deliberately shows NO projected take-home. Contributions, the pot
// and savings are decided when the month is finalised; a number shown
// now would move later, and the first figure someone sees is the one
// they remember and argue from.
function ThisMonth() {
  const [c, setC] = useState(null)
  const [err, setErr] = useState(null)
  // Never swallow this. A silent blank on a pay page reads as "you owe
  // nothing", which is a claim rather than an absence — the first
  // version hid a broken query behind an empty space.
  useEffect(() => {
    loadMyCredit().then(c2 => { setC(c2); setErr(null) })
      .catch(e => setErr(e.message || 'could not load'))
  }, [])

  if (err) {
    return (
      <section className="mt-4 rounded-2xl border border-clay bg-surface p-4">
        <p className="font-bold text-clay">This month could not be loaded</p>
        <p className="text-dim text-sm mt-1">
          Your credit for this month is not showing. It does not mean you owe
          nothing — ask the GM to check.
        </p>
        <p className="text-dim text-xs mt-2 break-words">{err}</p>
      </section>
    )
  }
  if (!c || !c.linked) return null

  if (!c.has_account) {
    // Silence would read as "I owe nothing", which is a different claim.
    return (
      <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
        <p className="font-bold">This month</p>
        <p className="text-dim text-sm mt-1">
          No credit account is linked to you yet, so nothing can be shown here.
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

  return (
    <section className="mt-4 rounded-2xl border border-amber bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-bold text-lg">This month so far</p>
        <span className="text-dim text-sm tnum">
          from {new Date(c.month_from + 'T12:00:00').toLocaleDateString('en-NG',
            { day: 'numeric', month: 'short' })}
        </span>
      </div>

      <div className="mt-3 space-y-1 text-sm">
        <Row label="Taken on credit this month" v={Number(c.taken_this_month || 0)} minus />
        {Number(c.repaid_this_month) > 0 && (
          <Row label="Already paid back this month" v={Number(c.repaid_this_month)} plus />
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-line">
        <div className="text-dim text-sm">Still to come off your pay</div>
        <div className={`tnum text-3xl font-bold ${owing > 0.009 ? 'text-clay' : 'text-leaf'}`}>
          {naira(owing)}
        </div>
        {owing <= 0.009 && (
          <p className="text-leaf text-sm mt-1">Nothing owing. All of your pay is yours.</p>
        )}
      </div>

      {/* What a full month would leave. Shown because seeing credit against
          the salary it will come out of is what makes a person stop and
          think — a bare figure does not. Labelled as a full month on
          purpose: days not worked reduce it, and the person must not read
          this as a promise. Pot, contributions and savings are still not
          projected; those are settled at month end and a number shown now
          would move. */}
      {salary > 0 && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="space-y-1 text-sm">
            <Row label="Your salary for a full month" v={salary} />
            {owing > 0.009 && <Row label="Less what you owe" v={owing} minus />}
          </div>
          <div className="text-dim text-sm mt-2">
            If you work the full month, you would receive about
          </div>
          <div className="tnum text-2xl font-bold text-amber">{naira(Math.max(0, salary - owing))}</div>

          {hasDays ? (
            <p className="text-dim text-sm mt-1">
              {c.days_worked} of {c.working_days} days recorded so far this month.
              Fewer days worked means less than this.
            </p>
          ) : (
            <p className="text-dim text-sm mt-1">
              Your days for this month are not counted yet. Days not worked
              reduce this figure.
            </p>
          )}
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className="text-dim text-sm mt-4 mb-1">What you took</p>
          <ul className="divide-y divide-line/60">
            {items.map((it, i) => (
              <li key={i} className="py-1.5 flex items-baseline gap-3 text-sm">
                <span className="text-dim tnum shrink-0 w-14">
                  {new Date(it.date + 'T12:00:00').toLocaleDateString('en-NG',
                    { day: 'numeric', month: 'short' })}
                </span>
                <span className="flex-1 min-w-0 truncate">
                  {Number(it.qty) > 1 ? `${Number(it.qty)} × ` : ''}{it.item}
                  {it.department && <span className="text-dim"> · {it.department}</span>}
                </span>
                <span className="tnum shrink-0">{naira(Number(it.amount))}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {repayments.length > 0 && (
        <>
          <p className="text-dim text-sm mt-4 mb-1">What you paid back</p>
          <ul className="divide-y divide-line/60">
            {repayments.map((r, i) => (
              <li key={i} className="py-1.5 flex items-baseline gap-3 text-sm">
                <span className="text-dim tnum shrink-0 w-14">
                  {new Date(r.date + 'T12:00:00').toLocaleDateString('en-NG',
                    { day: 'numeric', month: 'short' })}
                </span>
                <span className="flex-1 min-w-0 truncate text-dim">
                  {r.note || (r.method === 'payroll' ? 'Taken from your pay' : r.method?.toUpperCase())}
                </span>
                <span className="tnum text-leaf shrink-0">{naira(Number(r.amount))}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-dim text-xs mt-4">
        This is an estimate, not your pay slip. Any pot, contribution or
        savings is worked out when the month is finished, and days not worked
        reduce what you receive. If an item here is not yours, say so now
        rather than at the end of the month.
      </p>
    </section>
  )
}

export default function MyPay({ data }) {
  if (!data) return <p className="px-5 text-dim">Loading…</p>
  if (!data.linked) {
    return <p className="px-5 py-8 text-center text-dim">
      Your login is not linked to a pay record yet. Ask the GM.</p>
  }
  if (!data.months.length) {
    return (
      <div className="px-5 pb-8">
        <ThisMonth />
        <p className="py-8 text-center text-dim">
          No finished month yet. Your pay slip shows here once the month is finalised.
        </p>
      </div>
    )
  }

  const manyBranches = new Set(data.months.map(m => m.branch)).size > 1
  return (
    <div className="px-5 pb-8">
      <p className="text-dim text-sm py-2">Only you can see this.</p>
      <ThisMonth />
      <p className="text-dim text-sm pt-5">Finished months</p>
      {data.months.map(m => {
        const t = lineTotals(m, m.pot, m.working_days)
        const extra = [...(m.payroll_addition || [])]
        return (
          <section key={`${m.year}-${m.month}-${m.branch}`} className="mt-4 rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-bold text-lg">{MONTHS[m.month - 1]} {m.year}
                {manyBranches && m.branch && <span className="text-dim text-sm font-normal"> · {m.branch}</span>}
              </h2>
              <span className="text-dim text-sm tnum">{m.days_worked} of {m.working_days} days</span>
            </div>
            <div className="mt-1 text-dim text-sm">You received</div>
            <div className="tnum text-3xl font-bold text-amber">{naira(t.net)}</div>

            <div className="mt-3 space-y-1 text-sm">
              <Row label={`Pay for ${m.days_worked} days (salary ${naira(m.monthly_salary)})`} v={t.earned} />
              {Number(m.additions) > 0 && <Row label="Addition" v={Number(m.additions)} plus />}
              {extra.map((a, i) => <Row key={i} label={a.note || (a.source === 'award' ? 'Staff of the Month prize' : 'Addition')} v={Number(a.amount)} plus />)}
              {(m.payroll_deduction || []).map((d, i) => (
                <Row key={i} label={d.note || (d.source === 'credit' ? 'Credit taken' : d.source === 'advance' ? 'Salary advance' : 'Deduction')}
                     v={Number(d.amount)} minus />
              ))}
              {t.contribution > 0 && <Row label="Paid into the contribution pot" v={t.contribution} minus />}
              {t.pot > 0 && <Row label="Received from the pot" v={t.pot} plus />}
              {t.savings > 0 && <Row label="Held as your savings" v={t.savings} minus />}
            </div>
            {m.remark && <p className="mt-2 text-dim text-xs">{m.remark}</p>}
          </section>
        )
      })}
    </div>
  )
}

function Row({ label, v, plus, minus }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span className={`tnum ${minus ? 'text-clay' : plus ? 'text-leaf' : ''}`}>
        {minus ? '−' : plus ? '+' : ''}{naira(v)}
      </span>
    </div>
  )
}
