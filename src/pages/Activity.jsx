import { useEffect, useState } from 'react'
import { SUPERVISOR, is } from '../lib/roles'
import { loadStaffActivity } from '../lib/data'
import { useToast } from '../components/Toast'
import { lagosTime } from '../lib/format'

const roleLabel = r => ({ front_desk: 'Front desk', gm: 'GM', admin: 'Admin', storekeeper: 'Storekeeper',
  manager: 'Manager', auditor: 'Auditor', bar: 'Bar' }[r] || r || '')

const when = ts => {
  if (!ts) return 'never'
  const d = new Date(ts), mins = Math.round((Date.now() - d) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  if (day === today) return `today ${lagosTime(ts)}`
  const days = Math.round((new Date(today) - new Date(day)) / 864e5)
  if (days === 1) return `yesterday ${lagosTime(ts)}`
  return `${days} days ago`
}
const stamp = ts => `${new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' })} ${lagosTime(ts)}`

function Bars({ rows, tone }) {
  const max = Math.max(1, ...rows.map(r => r.count))
  return (
    <ul className="mt-1 space-y-1.5">
      {rows.map(r => (
        <li key={r.name} className="text-sm">
          <div className="flex justify-between gap-3">
            <span className="truncate">{r.name}</span>
            <span className="tnum text-dim shrink-0">{r.count}× · last {when(r.last)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-raise overflow-hidden">
            <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// Who uses the app, which pages they open and what they do - GM / admin only.
// Pages are counted each time one is opened (staying on it is not re-counted);
// actions are the key saves (sales, charges, payments, counts, deletions).
export default function Activity({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    if (!is(staff.role, SUPERVISOR)) return
    setRows(null)
    loadStaffActivity(boot.viewBranchId || staff.branch_id, days)
      .then(setRows)
      .catch(e => { setRows([]); toast(/function|does not exist/i.test(e.message)
        ? 'Staff activity is not switched on yet — run the 342 SQL first.' : e.message, 'error') })
  }, [staff.branch_id, boot.viewBranchId, days])

  if (!is(staff.role, SUPERVISOR)) {
    return <p className="px-5 py-8 text-dim">Staff activity is for the GM and admin only.</p>
  }

  const used = (rows || []).filter(r => r.last_seen && (r.visits + r.actions_total) > 0)
  const idle = (rows || []).filter(r => !used.includes(r))

  return (
    <div className="px-5 pb-8">
      <h2 className="text-xl font-bold mt-2">Staff activity</h2>
      <p className="text-dim text-sm mt-1">
        Pages each person opened and the key things they did. Counts start from the day this was switched on.
      </p>
      <div className="mt-3 flex gap-2">
        {[7, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`h-10 px-4 rounded-xl border text-sm font-semibold ${days === d ? 'border-amber text-amber' : 'border-line text-dim'}`}>
            Last {d} days
          </button>
        ))}
      </div>

      {!rows && <p className="text-dim py-6">Loading…</p>}
      {rows && !used.length && <p className="text-dim py-6">No activity recorded yet in this period.</p>}

      <ul className="mt-4 space-y-3">
        {used.map(r => {
          const isOpen = open === r.staff_id
          return (
            <li key={r.staff_id} className="rounded-2xl border border-line bg-surface">
              <button onClick={() => setOpen(isOpen ? null : r.staff_id)} className="w-full text-left px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold truncate">{r.name}</p>
                    <p className="text-dim text-sm">{roleLabel(r.role)} · last seen {when(r.last_seen)}</p>
                    {r.pages[0] && <p className="text-dim text-sm">Most used: {r.pages.slice(0, 3).map(p => p.name).join(', ')}</p>}
                  </div>
                  <div className="text-right shrink-0 text-sm">
                    <p className="tnum"><b>{r.days_active}</b> <span className="text-dim">day{r.days_active === 1 ? '' : 's'}</span></p>
                    <p className="tnum"><b>{r.visits}</b> <span className="text-dim">page visits</span></p>
                    <p className="tnum"><b>{r.actions_total}</b> <span className="text-dim">actions</span></p>
                  </div>
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-line/60 pt-3 space-y-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-dim">Pages opened</p>
                    {r.pages.length ? <Bars rows={r.pages} tone="bg-amber" /> : <p className="text-dim text-sm">None.</p>}
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-dim">What they did</p>
                    {r.actions.length ? <Bars rows={r.actions} tone="bg-leaf" /> : <p className="text-dim text-sm">Nothing recorded.</p>}
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-dim">Latest</p>
                    <ul className="mt-1 text-sm divide-y divide-line/50">
                      {r.recent.map((e, i) => (
                        <li key={i} className="py-1.5 flex justify-between gap-3">
                          <span className={e.kind === 'action' ? 'text-leaf' : ''}>
                            {e.kind === 'action' ? e.name : `Opened ${e.name}`}
                          </span>
                          <span className="text-dim shrink-0">{stamp(e.at)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {idle.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-bold uppercase tracking-wide text-dim">No activity in this period</p>
          <p className="text-sm text-dim mt-1">{idle.map(r => `${r.name} (${roleLabel(r.role)})`).join(' · ')}</p>
        </div>
      )}
    </div>
  )
}
