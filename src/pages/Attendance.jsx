import { useCallback, useEffect, useState } from 'react'
import { SUPERVISOR, is } from '../lib/roles'
import { loadAttendance, setBranchGeofence } from '../lib/data'
import { currentPosition } from '../lib/presence'
import { useToast } from '../components/Toast'
import { lagosTime } from '../lib/format'

const roleLabel = r => ({ front_desk: 'Front desk', storekeeper: 'Storekeeper', manager: 'Manager',
  auditor: 'Auditor', bar: 'Bar' }[r] || r || '')
const dShort = d => new Date(String(d).slice(0, 10) + 'T12:00:00')
  .toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })
const lagosHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(new Date())) % 24

function statusOf(p) {
  if (p.today_first_in) {
    const mins = (Date.now() - new Date(p.today_last_seen)) / 60000
    return mins <= 25
      ? { key: 'on', text: `On site now · in at ${lagosTime(p.today_first_in)}`, tone: 'text-leaf' }
      : { key: 'was', text: `In at ${lagosTime(p.today_first_in)} · last seen ${lagosTime(p.today_last_seen)}`, tone: 'text-amber' }
  }
  if (p.denied_today) return { key: 'blocked', text: 'Location blocked on their phone', tone: 'text-clay' }
  return lagosHour() < 9
    ? { key: 'early', text: 'Not started yet (tracking runs 9am to 8pm)', tone: 'text-dim' }
    : { key: 'none', text: 'Not seen at the branch today', tone: 'text-clay' }
}

// Who is at the branch, from the location their phone reports while the app is
// open between 9am and 8pm (see lib/presence.js). GM / admin only.
export default function Attendance({ boot }) {
  const { staff } = boot
  const toast = useToast()
  const branchId = boot.viewBranchId || staff.branch_id
  const [days, setDays] = useState(14)
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [radius, setRadius] = useState(150)

  const refresh = useCallback(() => {
    loadAttendance(branchId, days).then(d => { setData(d); if (d.geofence?.radius_m) setRadius(d.geofence.radius_m) })
      .catch(e => { setData({ geofence: { set: false }, people: [] }); toast(/function|does not exist/i.test(e.message)
        ? 'Attendance is not switched on yet — run the 346 SQL first.' : e.message, 'error') })
  }, [branchId, days, toast])
  useEffect(() => { if (is(staff.role, SUPERVISOR)) { setData(null); refresh() } }, [refresh])

  if (!is(staff.role, SUPERVISOR)) return <p className="px-5 py-8 text-dim">Attendance is for the GM and admin only.</p>

  const setHere = async () => {
    if (!window.confirm(`Set this branch's location to where you are standing now? Staff will count as on site within ${radius} metres of this spot.`)) return
    setBusy(true)
    try {
      const pos = await currentPosition()
      if (pos.accuracy > 100 && !window.confirm(`Your phone's location is only accurate to about ${Math.round(pos.accuracy)} metres. Use it anyway? (Better: go outside or near a window and try again.)`)) { setBusy(false); return }
      await setBranchGeofence(branchId, pos.lat, pos.lng, Number(radius) || 150)
      toast('Branch location saved.')
      refresh()
    } catch (e) {
      toast(e.code === 1 ? 'Allow location for this app in your phone settings, then try again.' : (e.message || 'Could not get your location.'), 'error')
    } finally { setBusy(false) }
  }

  const people = (data?.people || []).map(p => ({ ...p, st: statusOf(p) }))
  const count = k => people.filter(p => p.st.key === k).length

  return (
    <div className="px-5 pb-8">
      <h2 className="text-xl font-bold mt-2">Attendance</h2>
      <p className="text-dim text-sm mt-1">
        Recorded from staff phones while the app is open, 9am to 8pm. "Last seen" is the last time the app saw them at the branch, not an exact leaving time.
      </p>

      {data && (
        <section className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <p className="font-bold">Branch location</p>
          {data.geofence?.set
            ? <p className="text-sm text-leaf mt-1">Set · staff count as on site within {data.geofence.radius_m} m</p>
            : <p className="text-sm text-clay mt-1">Not set yet. Nobody can be marked on site until you set it.</p>}
          <div className="mt-3 flex items-center gap-2">
            <label className="text-dim text-sm shrink-0" htmlFor="rad">Radius (m)</label>
            <input id="rad" type="number" inputMode="numeric" min="30" max="1000" value={radius}
              onChange={e => setRadius(e.target.value)} className="h-10 w-24 px-3 rounded-xl bg-raise border border-line tnum" />
            <button onClick={setHere} disabled={busy}
              className="flex-1 h-10 rounded-xl border-2 border-amber text-amber text-sm font-bold disabled:opacity-50">
              {busy ? 'Getting location…' : data.geofence?.set ? 'Reset to where I am now' : 'Set to where I am now'}
            </button>
          </div>
          <p className="text-dim text-xs mt-2">Stand inside the branch (the middle of the property is best) when you do this.</p>
        </section>
      )}

      {data && data.geofence?.set && (
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-surface border border-line p-3"><div className="tnum text-2xl font-bold text-leaf">{count('on')}</div><div className="text-dim text-xs">on site now</div></div>
          <div className="rounded-xl bg-surface border border-line p-3"><div className="tnum text-2xl font-bold text-amber">{count('was')}</div><div className="text-dim text-xs">in, last seen earlier</div></div>
          <div className="rounded-xl bg-surface border border-line p-3"><div className="tnum text-2xl font-bold text-clay">{count('none') + count('blocked')}</div><div className="text-dim text-xs">not seen today</div></div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2">
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`h-9 px-2 rounded-xl border text-xs font-semibold whitespace-nowrap ${days === d ? 'border-amber text-amber' : 'border-line text-dim'}`}>
            {d} days
          </button>
        ))}
      </div>

      {!data && <p className="text-dim py-6">Loading…</p>}
      {data && !people.length && <p className="text-dim py-6">No staff to show for this branch.</p>}

      <ul className="mt-4 space-y-3">
        {people.map(p => {
          const isOpen = open === p.staff_id
          return (
            <li key={p.staff_id} className="rounded-2xl border border-line bg-surface">
              <button onClick={() => setOpen(isOpen ? null : p.staff_id)} className="w-full text-left px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold truncate">{p.name}</p>
                    <p className="text-dim text-sm">{roleLabel(p.role)}</p>
                    <p className={`text-sm ${p.st.tone}`}>{p.st.text}</p>
                  </div>
                  <div className="text-right shrink-0 text-sm">
                    <p className="tnum"><b>{p.days_present}</b> <span className="text-dim">of {days} days</span></p>
                  </div>
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-line/60 pt-3">
                  {!p.days.length
                    ? <p className="text-dim text-sm">Not seen at the branch in this period.</p>
                    : <ul className="text-sm divide-y divide-line/50">
                        {p.days.map(d => (
                          <li key={d.day} className="py-1.5 flex justify-between gap-3">
                            <span>{dShort(d.day)}</span>
                            <span className="text-dim tnum">in {lagosTime(d.first_in)} · last seen {lagosTime(d.last_seen)}</span>
                          </li>
                        ))}
                      </ul>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
