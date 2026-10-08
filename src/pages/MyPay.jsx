import { naira } from '../lib/format'
import { lineTotals } from '../lib/payroll'

const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December']

export default function MyPay({ data }) {
  if (!data) return <p className="px-5 text-dim">Loading…</p>
  if (!data.linked) {
    return <p className="px-5 py-8 text-center text-dim">
      Your login is not linked to a pay record yet. Ask the GM.</p>
  }
  if (!data.months.length) {
    return <p className="px-5 py-8 text-center text-dim">
      No finished month yet. Your pay slip shows here once the month is finalised.</p>
  }

  const manyBranches = new Set(data.months.map(m => m.branch)).size > 1
  return (
    <div className="px-5 pb-8">
      <p className="text-dim text-sm py-2">Only you can see this. Shows each finished month.</p>
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
