import { useEffect, useState, useCallback } from 'react'
import { supabase } from './lib/supabase'
import { loadBootstrap, loadStaffIdentity, loadBranchData } from './lib/data'
import Login from './pages/Login'
import SalesEntry from './pages/SalesEntry'
import Stock from './pages/Stock'
import Store from './pages/Store'
import Corrections from './pages/Corrections'
import DailySales from './pages/DailySales'
import Catalog from './pages/Catalog'
import Variances from './pages/Variances'
import Recovery from './pages/Recovery'
import More from './pages/More'
import { ToastHost } from './components/Toast'
import { registerHandlers, flush } from './lib/outbox'
import { saveBasket, saveWriteoff, saveMovements, loadBranches,
         saveRepayment, saveCountLine, loadPendingVerifications } from './lib/data'
import Credit from './pages/Credit'
import Counts from './pages/Counts'
import Shell from './components/Shell'
import ErrorBoundary from './components/ErrorBoundary'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [identity, setIdentity] = useState(undefined) // undefined = not loaded yet, null = no session, false = session but no staff row
  const [boot, setBoot] = useState(null)
  const [tab, setTab] = useState('sales')
  const [err, setErr] = useState(null)
  const [branches, setBranches] = useState([])
  const [viewBranch, setViewBranch] = useState(null)
  const [pendingCount, setPendingCount] = useState(0)

  const ALERT_ROLES = ['auditor', 'storekeeper', 'manager', 'gm', 'admin']

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // identity (auth check + staff row) only needs to run once per
  // session — not once per branch switch
  useEffect(() => {
    if (!session) { setIdentity(undefined); setBoot(null); return }
    loadStaffIdentity().then(staff => setIdentity(staff === undefined ? null : (staff || false)))
      .catch(e => setErr(e.message))
  }, [session])

  const refresh = useCallback(() => {
    if (identity === undefined) return          // still loading identity
    if (identity === null) { setBoot(null); return }  // no session
    if (identity === false) { setBoot({ staff: null }); return } // not linked
    loadBranchData(identity, viewBranch).then(b => {
      setBoot(b)
      if (b?.seesAllBranches && !branches.length) loadBranches().then(setBranches)
    }).catch(e => setErr(e.message))
  }, [identity, viewBranch])

  useEffect(refresh, [refresh])

  // badge for auditor/storekeeper/manager/gm/admin: how many counts
  // are waiting for verification right now. Refetches on branch
  // switch and every 60s while the app stays open, so it stays
  // current without needing a full reload — this is an in-app alert,
  // not a push notification, so it only updates while someone is
  // actually looking at the app.
  useEffect(() => {
    if (!boot?.staff || !ALERT_ROLES.includes(boot.staff.role)) { setPendingCount(0); return }
    const check = () => loadPendingVerifications(boot.staff.branch_id).then(setPendingCount)
    check()
    const id = setInterval(check, 60000)
    return () => clearInterval(id)
  }, [boot?.staff?.branch_id, boot?.staff?.role])

  // queued writes replay with the same code path as live ones
  useEffect(() => {
    registerHandlers({
      basket: (p) => saveBasket({
        staff: p.staffLite, locationId: p.locationId, date: p.date,
        customerId: p.customerId, payments: p.payments, lines: p.lines,
        backdateReason: p.backdateReason, onBehalfOf: p.onBehalfOf,
      }),
      movements: (p) => saveMovements(p.rows),
      repayment: (p) => saveRepayment({ ...p, staff: p.staffLite }),
      countLine: (p) => saveCountLine(p.countId, p.itemId, p.qty),
      writeoff: (p) => saveWriteoff({
        staff: p.staffLite, item: { id: p.itemId }, locationId: p.locationId,
        kind: p.kind, qty: p.qty, unitValue: p.unitValue, date: p.date,
        note: p.note || null, damageReason: p.damageReason || null,
      }),
    })
    flush()
  }, [])

  if (session === undefined) return <Center>Loading…</Center>
  if (!session) return <Login />
  if (err) return <Center>Couldn't load your profile. {err}</Center>
  if (!boot) return <Center>Loading…</Center>
  if (!boot.staff) return (
    <Center>
      <p className="max-w-xs text-center leading-relaxed">
        You're signed in, but this account isn't linked to a staff record yet.
        Ask a manager to link it, then reload.
      </p>
      <button onClick={() => window.confirm('Sign out?') && supabase.auth.signOut()}
        className="mt-6 text-amber">Sign out</button>
    </Center>
  )

  return (
    <ErrorBoundary>
    <ToastHost>
    <Shell staff={boot.staff} tab={tab} onTab={setTab}
      branches={boot.seesAllBranches ? branches : []}
      viewBranch={boot.viewBranchId} onBranch={setViewBranch}
      pendingCount={pendingCount}>
      {tab === 'sales' ? <SalesEntry boot={boot} />
        : tab === 'store' ? <Store boot={boot} />
        : tab === 'more' ? <More boot={boot} onGo={setTab} pendingCount={pendingCount} />
        : tab === 'dailysales' ? <DailySales boot={boot} />
        : tab === 'catalog' ? <Catalog boot={boot} onChanged={refresh} />
        : tab === 'variance' ? <Variances boot={boot} />
        : tab === 'recovery' ? <Recovery boot={boot} />
        : tab === 'credit' ? <Credit boot={boot} />
        : tab === 'count' ? <Counts boot={boot} />
        : tab === 'fix' ? <Corrections boot={boot} />
        : <Stock boot={boot} />}
    </Shell>
    </ToastHost>
    </ErrorBoundary>
  )
}

function Center({ children }) {
  return <div className="min-h-dvh flex flex-col items-center justify-center text-dim">{children}</div>
}
